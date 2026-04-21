import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock windowLifecycle so the hook doesn't try to talk to Tauri.
const resizeToModeMock = vi.fn<(mode: "compact" | "full") => Promise<void>>(() => Promise.resolve());
vi.mock("../windowLifecycle", () => ({
  resizeToMode: (mode: "compact" | "full") => resizeToModeMock(mode),
}));

// Import AFTER the mock so the hook picks up the stubbed resizeToMode.
import { useUIMode } from "../useUIMode";

describe("useUIMode — transition orchestration", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resizeToModeMock.mockClear();
    resizeToModeMock.mockImplementation(() => Promise.resolve());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resizes to the target mode and swaps currentMode after fade-in", async () => {
    const { result } = renderHook(() => useUIMode());
    expect(result.current.currentMode).toBe("compact");
    expect(result.current.isUITransitioning).toBe(false);

    let switchPromise!: Promise<void>;
    act(() => {
      switchPromise = result.current.switchUIMode("full");
    });

    // Phase 1 is a fade-out gated on a transitionend event that jsdom never
    // fires — the hook falls back to the safety timeout (~280ms).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
      await switchPromise;
    });

    expect(resizeToModeMock).toHaveBeenCalledWith("full");
    expect(result.current.currentMode).toBe("full");
    expect(result.current.isUITransitioning).toBe(false);
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
