import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock windowLifecycle so the hook doesn't try to talk to Tauri.
const resizeToModeMock = vi.fn<(mode: "compact" | "full") => Promise<void>>(() => Promise.resolve());
vi.mock("../windowLifecycle", () => ({
  resizeToMode: (mode: "compact" | "full") => resizeToModeMock(mode),
}));

// Import AFTER the mock so the hook picks up the stubbed resizeToMode.
import { useUIMode } from "../useUIMode";

function setPrefersReducedMotion(value: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query.includes("reduce") ? value : false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

describe("useUIMode — LED edge sweep orchestration", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resizeToModeMock.mockClear();
    resizeToModeMock.mockImplementation(() => Promise.resolve());
    setPrefersReducedMotion(false);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("arms the sweep overlay while resizing and clears it after", async () => {
    const { result } = renderHook(() => useUIMode());
    expect(result.current.currentMode).toBe("compact");
    expect(result.current.isSweepActive).toBe(false);

    let switchPromise!: Promise<void>;
    act(() => {
      switchPromise = result.current.switchUIMode("full");
    });

    // Phase 1 is a fade-out gated on a transitionend event that jsdom never
    // fires — the hook falls back to the safety timeout (~280ms).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(result.current.isSweepActive).toBe(true);
    expect(resizeToModeMock).toHaveBeenCalledWith("full");

    // Let the sweep timer + resize both finish.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
    });

    expect(result.current.isSweepActive).toBe(false);

    // Flush fade-in phase so the hook drops its lock cleanly.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
      await switchPromise;
    });

    expect(result.current.currentMode).toBe("full");
  });

  it("skips the sweep under prefers-reduced-motion", async () => {
    setPrefersReducedMotion(true);
    const { result } = renderHook(() => useUIMode());

    let switchPromise!: Promise<void>;
    act(() => {
      switchPromise = result.current.switchUIMode("full");
    });

    // Drive through all phases; sweep must never flip on.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1200);
      await switchPromise;
    });

    expect(result.current.isSweepActive).toBe(false);
    expect(resizeToModeMock).toHaveBeenCalledWith("full");
    expect(result.current.currentMode).toBe("full");
  });

  it("re-entrancy guard: a second switch during an active transition is ignored", async () => {
    const { result } = renderHook(() => useUIMode());

    let first!: Promise<void>;
    act(() => {
      first = result.current.switchUIMode("full");
    });

    // Fire a second call immediately — should no-op because the lock is held.
    act(() => {
      void result.current.switchUIMode("compact");
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
      await first;
    });

    // resizeToMode should have been called exactly once, for "full".
    expect(resizeToModeMock).toHaveBeenCalledTimes(1);
    expect(resizeToModeMock).toHaveBeenCalledWith("full");
    expect(result.current.currentMode).toBe("full");
  });
});
