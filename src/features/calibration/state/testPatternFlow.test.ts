import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildLedSequence } from "../model/indexMapping";
import type { LedCalibrationConfig } from "../model/contracts";
import { createDefaultTestPatternFlow, createTestPatternFlow } from "./testPatternFlow";

vi.mock("../calibrationApi", () => ({
  startCalibrationTestPattern: vi.fn(async () => undefined),
  stopCalibrationTestPattern: vi.fn(async () => undefined),
}));

const calibrationApiModule = await import("../calibrationApi");

const startCalibrationTestPatternMock = vi.mocked(calibrationApiModule.startCalibrationTestPattern);
const stopCalibrationTestPatternMock = vi.mocked(calibrationApiModule.stopCalibrationTestPattern);

beforeEach(() => {
  (globalThis as { window?: Window & typeof globalThis }).window = {
    requestAnimationFrame: (() => 1) as typeof window.requestAnimationFrame,
    cancelAnimationFrame: (() => undefined) as typeof window.cancelAnimationFrame,
  } as Window & typeof globalThis;
});

const BASE_COUNTS = {
  top: 4,
  right: 3,
  bottomRight: 2,
  bottomLeft: 2,
  left: 3,
} as const;

function createConfig(overrides?: Partial<LedCalibrationConfig>): LedCalibrationConfig {
  const totalLeds =
    BASE_COUNTS.top +
    BASE_COUNTS.right +
    BASE_COUNTS.bottomRight +
    BASE_COUNTS.bottomLeft +
    BASE_COUNTS.left;

  return {
    counts: { ...BASE_COUNTS },
    bottomGapPx: 24,
    startAnchor: "left-end",
    direction: "cw",
    totalLeds,
    ...overrides,
  };
}

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

describe("createDefaultTestPatternFlow", () => {
  it("uses buildLedSequence result for physical ledIndexes on toggle", async () => {
    startCalibrationTestPatternMock.mockClear();
    stopCalibrationTestPatternMock.mockClear();
    const config = createConfig();
    const flow = createDefaultTestPatternFlow(async () => ({ connected: true }), config);

    await flow.toggle(true);

    expect(startCalibrationTestPatternMock).toHaveBeenCalledTimes(1);
    expect(startCalibrationTestPatternMock).toHaveBeenLastCalledWith({
      ledIndexes: [buildLedSequence(config)[0].index],
      frameMs: 120,
      brightness: 64,
    });
  });

  it("setConfig updates ledIndexes on next toggle", async () => {
    startCalibrationTestPatternMock.mockClear();
    stopCalibrationTestPatternMock.mockClear();
    const initialConfig = createConfig();
    const nextConfig = createConfig({
      startAnchor: "bottom-right-end",
      direction: "ccw",
    });
    const flow = createDefaultTestPatternFlow(async () => ({ connected: true }), initialConfig);

    await flow.toggle(true);
    await flow.toggle(false);
    flow.setConfig(nextConfig);
    await flow.toggle(true);

    expect(startCalibrationTestPatternMock).toHaveBeenNthCalledWith(1, {
      ledIndexes: [buildLedSequence(initialConfig)[0].index],
      frameMs: 120,
      brightness: 64,
    });
    expect(startCalibrationTestPatternMock).toHaveBeenNthCalledWith(2, {
      ledIndexes: [buildLedSequence(nextConfig)[0].index],
      frameMs: 120,
      brightness: 64,
    });
  });
});
