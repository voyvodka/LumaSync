import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FRAME_WAIT_FALLBACK_MS, waitForFrames } from "../frameWait";

// A hand-driven rAF: callbacks queue until `flushFrame()`, and `paused`
// models a hidden window, where the webview never runs them at all.
let queued = new Map<number, FrameRequestCallback>();
let nextId = 1;
const cancelSpy = vi.fn((id: number) => {
  queued.delete(id);
});

function flushFrame() {
  const due = queued;
  queued = new Map();
  for (const cb of due.values()) cb(performance.now());
}

beforeEach(() => {
  vi.useFakeTimers();
  queued = new Map();
  nextId = 1;
  cancelSpy.mockClear();
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    const id = nextId++;
    queued.set(id, cb);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", cancelSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function track(p: Promise<void>) {
  const state = { done: false };
  void p.then(() => {
    state.done = true;
  });
  return state;
}

describe("waitForFrames", () => {
  it("resolves on the second frame when frames arrive, and clears its fallback timer", async () => {
    const wait = track(waitForFrames(2));

    flushFrame();
    await Promise.resolve();
    expect(wait.done).toBe(false);

    flushFrame();
    await Promise.resolve();
    expect(wait.done).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("resolves at the fallback when no frame ever fires, and cancels the pending frame", async () => {
    const wait = track(waitForFrames(2));

    await vi.advanceTimersByTimeAsync(FRAME_WAIT_FALLBACK_MS - 1);
    expect(wait.done).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(wait.done).toBe(true);
    expect(cancelSpy).toHaveBeenCalledTimes(1);
    expect(queued.size).toBe(0);
  });

  it("falls back when the frames stop after the first one", async () => {
    const wait = track(waitForFrames(2));

    flushFrame();
    await vi.advanceTimersByTimeAsync(FRAME_WAIT_FALLBACK_MS);

    expect(wait.done).toBe(true);
    expect(queued.size).toBe(0);
  });

  it("the fallback stays inert once frames have won", async () => {
    const wait = track(waitForFrames(1));
    flushFrame();
    await Promise.resolve();
    expect(wait.done).toBe(true);

    await vi.advanceTimersByTimeAsync(FRAME_WAIT_FALLBACK_MS * 2);
    expect(cancelSpy).not.toHaveBeenCalled();
  });
});
