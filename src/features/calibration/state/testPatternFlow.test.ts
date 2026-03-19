import { describe, expect, it, vi } from "vitest";

import { createTestPatternFlow } from "./testPatternFlow";

function createRafHarness(startMs = 1_000) {
  let nowMs = startMs;
  let rafId = 0;
  const callbacks = new Map<number, FrameRequestCallback>();

  return {
    now: () => nowMs,
    advanceBy: (deltaMs: number) => {
      nowMs += deltaMs;
      const pending = [...callbacks.entries()];
      callbacks.clear();
      for (const [, callback] of pending) {
        callback(nowMs);
      }
    },
    scheduleFrame: (callback: FrameRequestCallback) => {
      rafId += 1;
      callbacks.set(rafId, callback);
      return rafId;
    },
    cancelFrame: (id: number) => {
      callbacks.delete(id);
    },
  };
}

describe("createTestPatternFlow", () => {
  it("starts local preview immediately and invokes hardware start when connected", async () => {
    const startPhysicalPattern = vi.fn(async () => undefined);
    const stopPhysicalPattern = vi.fn(async () => undefined);
    const raf = createRafHarness();

    const flow = createTestPatternFlow({
      getConnectionStatus: async () => ({ connected: true }),
      startPhysicalPattern,
      stopPhysicalPattern,
      now: raf.now,
      scheduleFrame: raf.scheduleFrame,
      cancelFrame: raf.cancelFrame,
    });

    const toggleResult = await flow.toggle(true);

    expect(toggleResult.isEnabled).toBe(true);
    expect(toggleResult.mode).toBe("sending");
    expect(startPhysicalPattern).toHaveBeenCalledTimes(1);

    raf.advanceBy(140);
    expect(flow.getSnapshot().markerIndex).toBeGreaterThan(0);
  });

  it("always stops hardware on toggle off and dispose", async () => {
    const startPhysicalPattern = vi.fn(async () => undefined);
    const stopPhysicalPattern = vi.fn(async () => undefined);
    const raf = createRafHarness();

    const flow = createTestPatternFlow({
      getConnectionStatus: async () => ({ connected: true }),
      startPhysicalPattern,
      stopPhysicalPattern,
      now: raf.now,
      scheduleFrame: raf.scheduleFrame,
      cancelFrame: raf.cancelFrame,
    });

    await flow.toggle(true);
    await flow.toggle(false);
    await flow.toggle(true);
    await flow.dispose();

    expect(stopPhysicalPattern).toHaveBeenCalledTimes(2);
  });

  it("falls back to preview-only when disconnected without save blocking", async () => {
    const startPhysicalPattern = vi.fn(async () => undefined);
    const stopPhysicalPattern = vi.fn(async () => undefined);
    const raf = createRafHarness();

    const flow = createTestPatternFlow({
      getConnectionStatus: async () => ({ connected: false }),
      startPhysicalPattern,
      stopPhysicalPattern,
      now: raf.now,
      scheduleFrame: raf.scheduleFrame,
      cancelFrame: raf.cancelFrame,
    });

    const snapshot = await flow.toggle(true);

    expect(snapshot.mode).toBe("preview-only");
    expect(snapshot.isBlockingSave).toBe(false);
    expect(startPhysicalPattern).not.toHaveBeenCalled();
  });

  it("uses configured led count to loop preview marker", async () => {
    const raf = createRafHarness();
    const flow = createTestPatternFlow({
      getConnectionStatus: async () => ({ connected: false }),
      startPhysicalPattern: async () => undefined,
      stopPhysicalPattern: async () => undefined,
      now: raf.now,
      scheduleFrame: raf.scheduleFrame,
      cancelFrame: raf.cancelFrame,
    });

    flow.setTotalLeds(2);
    await flow.toggle(true);

    raf.advanceBy(130);
    expect(flow.getSnapshot().markerIndex).toBe(1);

    raf.advanceBy(130);
    expect(flow.getSnapshot().markerIndex).toBe(0);
  });
});
