import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock windowLifecycle so the hook doesn't try to talk to Tauri.
const resizeToModeMock = vi.fn<(mode: "compact" | "full") => Promise<void>>(() => Promise.resolve());
vi.mock("../windowLifecycle", () => ({
  resizeToMode: (mode: "compact" | "full") => resizeToModeMock(mode),
}));

// Import AFTER the mock so the hook picks up the stubbed resizeToMode.
import { useUIMode } from "../useUIMode";
import { FRAME_WAIT_FALLBACK_MS } from "../frameWait";

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

    // Phase 1 is a fade-out gated on a transitionend event that happy-dom never
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

  it("hands a caller arriving mid-transition the running transition to await", async () => {
    const { result } = renderHook(() => useUIMode());

    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = result.current.switchUIMode("full");
    });
    act(() => {
      second = result.current.switchUIMode("full");
    });

    // Same promise: the second caller resumes when the window is full, not
    // before the resize it depends on has even started.
    expect(second).toBe(first);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
      await second;
    });
    expect(resizeToModeMock).toHaveBeenCalledTimes(1);
    expect(result.current.currentMode).toBe("full");
  });

  it("resolves at once when the window is already in the requested mode", async () => {
    const { result } = renderHook(() => useUIMode());

    await act(async () => {
      await result.current.switchUIMode("compact");
    });

    expect(resizeToModeMock).not.toHaveBeenCalled();
  });
});

// rAF is suspended while the window is hidden, occluded or the screen is
// locked. The phase-3 paint wait used to await it unbounded, which left the
// transition lock held and every later toggle ignored until frames resumed.
describe("useUIMode — paint waits when animation frames stop", () => {
  let queued: Map<number, FrameRequestCallback>;
  let nextId: number;

  function flushFrame() {
    const due = queued;
    queued = new Map();
    for (const cb of due.values()) cb(performance.now());
  }

  async function settle(ms = 0) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    queued = new Map();
    nextId = 1;
    resizeToModeMock.mockClear();
    resizeToModeMock.mockImplementation(() => Promise.resolve());
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      const id = nextId++;
      queued.set(id, cb);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      queued.delete(id);
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("completes a switch with no frames at all, releases the lock, and lets the next switch run", async () => {
    const { result } = renderHook(() => useUIMode());

    act(() => {
      void result.current.switchUIMode("full");
    });
    await settle(FRAME_WAIT_FALLBACK_MS - 1);

    expect(resizeToModeMock).toHaveBeenCalledWith("full");
    expect(result.current.currentMode).toBe("full");
    expect(result.current.isContentVisible).toBe(false);
    expect(result.current.isUITransitioning).toBe(true);

    await settle(1);

    expect(result.current.isContentVisible).toBe(true);
    expect(result.current.isUITransitioning).toBe(false);

    act(() => {
      void result.current.switchUIMode("compact");
    });
    await settle(FRAME_WAIT_FALLBACK_MS);

    expect(resizeToModeMock).toHaveBeenCalledTimes(2);
    expect(resizeToModeMock).toHaveBeenLastCalledWith("compact");
    expect(result.current.currentMode).toBe("compact");
    expect(result.current.isContentVisible).toBe(true);
    expect(result.current.isUITransitioning).toBe(false);
  });

  it("with frames firing, fades in on the second frame and never waits on the fallback", async () => {
    const { result } = renderHook(() => useUIMode());

    act(() => {
      void result.current.switchUIMode("full");
    });
    await settle();

    // Resize ran and the new layout is mounted at opacity 0 before any frame.
    expect(resizeToModeMock).toHaveBeenCalledWith("full");
    expect(result.current.currentMode).toBe("full");
    expect(result.current.isContentVisible).toBe(false);

    flushFrame();
    await settle();
    expect(result.current.isContentVisible).toBe(false);

    flushFrame();
    await settle();
    expect(result.current.isContentVisible).toBe(true);
    expect(result.current.isUITransitioning).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a failed resize fades the old layout back in and releases the lock", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    resizeToModeMock.mockImplementationOnce(() => Promise.reject(new Error("ipc down")));
    const { result } = renderHook(() => useUIMode());

    act(() => {
      void result.current.switchUIMode("full");
    });
    await settle();

    expect(result.current.currentMode).toBe("compact");
    expect(result.current.isContentVisible).toBe(true);
    expect(result.current.isUITransitioning).toBe(false);
    expect(errorSpy).toHaveBeenCalledWith("[LumaSync] switchUIMode failed:", expect.any(Error));

    act(() => {
      void result.current.switchUIMode("full");
    });
    await settle(FRAME_WAIT_FALLBACK_MS);
    expect(result.current.currentMode).toBe("full");
    errorSpy.mockRestore();
  });
});
