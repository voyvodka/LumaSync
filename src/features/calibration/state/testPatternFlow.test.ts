import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildLedSequence, resolveLedSequenceItem } from "../model/indexMapping";
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
  bottom: 4,
  left: 3,
} as const;

function createConfig(overrides?: Partial<LedCalibrationConfig>): LedCalibrationConfig {
  const totalLeds =
    BASE_COUNTS.top +
    BASE_COUNTS.right +
    BASE_COUNTS.bottom +
    BASE_COUNTS.left;

  return {
    counts: { ...BASE_COUNTS },
    bottomMissing: 0,
    cornerOwnership: "horizontal",
    visualPreset: "vivid",
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
  it("normalizes marker index lookup through shared sequence helper", () => {
    const config = createConfig({
      startAnchor: "bottom-end",
      direction: "ccw",
    });
    const sequence = buildLedSequence(config);

    const first = resolveLedSequenceItem(sequence, 0);
    const wrappedForward = resolveLedSequenceItem(sequence, config.totalLeds);
    const wrappedBackward = resolveLedSequenceItem(sequence, -1);

    expect(first).toEqual(sequence[0]);
    expect(wrappedForward).toEqual(sequence[0]);
    expect(wrappedBackward).toEqual(sequence[config.totalLeds - 1]);
  });

  it("returns null for marker lookup when sequence is empty", () => {
    expect(resolveLedSequenceItem([], 0)).toBeNull();
    expect(resolveLedSequenceItem([], 12)).toBeNull();
    expect(resolveLedSequenceItem([], -3)).toBeNull();
  });

  it("preserves canonical physical indexes across orientation changes", () => {
    const cwConfig = createConfig({
      startAnchor: "left-end",
      direction: "cw",
    });
    const ccwConfig = createConfig({
      startAnchor: "left-end",
      direction: "ccw",
    });

    const cwSequence = buildLedSequence(cwConfig);
    const ccwSequence = buildLedSequence(ccwConfig);

    expect(cwSequence[0]?.index).toBe(13);
    expect(ccwSequence[0]?.index).toBe(13);

    const expectedIndexes = Array.from({ length: cwConfig.totalLeds }, (_, index) => index);
    expect([...cwSequence.map((item) => item.index)].sort((a, b) => a - b)).toEqual(expectedIndexes);
    expect([...ccwSequence.map((item) => item.index)].sort((a, b) => a - b)).toEqual(expectedIndexes);
  });

  it("uses buildLedSequence result for physical ledIndexes on toggle", async () => {
    startCalibrationTestPatternMock.mockClear();
    stopCalibrationTestPatternMock.mockClear();
    const config = createConfig({
      startAnchor: "left-end",
      direction: "cw",
    });
    const flow = createDefaultTestPatternFlow(async () => ({ connected: true }), config);

    const snapshot = await flow.toggle(true);

    expect(startCalibrationTestPatternMock).toHaveBeenCalledTimes(1);
    expect(startCalibrationTestPatternMock).toHaveBeenLastCalledWith({
      ledIndexes: [buildLedSequence(config)[snapshot.markerIndex].index],
      frameMs: 120,
      brightness: 64,
    });
    expect(buildLedSequence(config)[snapshot.markerIndex].index).not.toBe(0);
  });

  it("uses active markerIndex for ledIndexes payload when connection resolves", async () => {
    startCalibrationTestPatternMock.mockClear();
    stopCalibrationTestPatternMock.mockClear();

    let rafCallback: (timestamp: number) => void = () => undefined;
    (globalThis as { window?: Window & typeof globalThis }).window = {
      requestAnimationFrame: ((callback: (timestamp: number) => void) => {
        rafCallback = callback;
        return 1;
      }) as typeof window.requestAnimationFrame,
      cancelAnimationFrame: (() => undefined) as typeof window.cancelAnimationFrame,
    } as Window & typeof globalThis;

    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000);
    let resolveConnection: (value: { connected: boolean }) => void = () => undefined;
    const pendingConnection = new Promise<{ connected: boolean }>((resolve) => {
      resolveConnection = resolve;
    });

    const config = createConfig({
      startAnchor: "left-end",
      direction: "cw",
    });
    const flow = createDefaultTestPatternFlow(async () => pendingConnection, config);

    const togglePromise = flow.toggle(true);
    expect(startCalibrationTestPatternMock).not.toHaveBeenCalled();

    rafCallback(1_130);
    resolveConnection({ connected: true });
    const snapshot = await togglePromise;

    const expectedPhysicalIndex = buildLedSequence(config)[snapshot.markerIndex].index;
    expect(snapshot.markerIndex).toBe(1);
    expect(startCalibrationTestPatternMock).toHaveBeenCalledTimes(1);
    expect(startCalibrationTestPatternMock).toHaveBeenLastCalledWith({
      ledIndexes: [expectedPhysicalIndex],
      frameMs: 120,
      brightness: 64,
    });

    nowSpy.mockRestore();
  });

  it("setConfig updates ledIndexes on next toggle", async () => {
    startCalibrationTestPatternMock.mockClear();
    stopCalibrationTestPatternMock.mockClear();
    const initialConfig = createConfig();
    const nextConfig = createConfig({
      startAnchor: "bottom-end",
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
    expect(buildLedSequence(initialConfig)[0].index).not.toBe(buildLedSequence(nextConfig)[0].index);
  });

  it("uses active markerIndex as physical fallback when config is absent", async () => {
    startCalibrationTestPatternMock.mockClear();
    stopCalibrationTestPatternMock.mockClear();

    let rafCallback: (timestamp: number) => void = () => undefined;
    (globalThis as { window?: Window & typeof globalThis }).window = {
      requestAnimationFrame: ((callback: (timestamp: number) => void) => {
        rafCallback = callback;
        return 1;
      }) as typeof window.requestAnimationFrame,
      cancelAnimationFrame: (() => undefined) as typeof window.cancelAnimationFrame,
    } as Window & typeof globalThis;

    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000);
    let resolveConnection: (value: { connected: boolean }) => void = () => undefined;
    const pendingConnection = new Promise<{ connected: boolean }>((resolve) => {
      resolveConnection = resolve;
    });

    const flow = createDefaultTestPatternFlow(async () => pendingConnection);
    const togglePromise = flow.toggle(true);

    rafCallback(1_130);
    resolveConnection({ connected: true });
    const snapshot = await togglePromise;

    expect(snapshot.markerIndex).toBe(1);
    expect(startCalibrationTestPatternMock).toHaveBeenCalledTimes(1);
    expect(startCalibrationTestPatternMock).toHaveBeenLastCalledWith({
      ledIndexes: [snapshot.markerIndex],
      frameMs: 120,
      brightness: 64,
    });

    nowSpy.mockRestore();
  });

  it("falls back to markerIndex when config sequence is empty", async () => {
    startCalibrationTestPatternMock.mockClear();
    stopCalibrationTestPatternMock.mockClear();

    let rafCallback: (timestamp: number) => void = () => undefined;
    (globalThis as { window?: Window & typeof globalThis }).window = {
      requestAnimationFrame: ((callback: (timestamp: number) => void) => {
        rafCallback = callback;
        return 1;
      }) as typeof window.requestAnimationFrame,
      cancelAnimationFrame: (() => undefined) as typeof window.cancelAnimationFrame,
    } as Window & typeof globalThis;

    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000);
    let resolveConnection: (value: { connected: boolean }) => void = () => undefined;
    const pendingConnection = new Promise<{ connected: boolean }>((resolve) => {
      resolveConnection = resolve;
    });

    const emptyConfig = createConfig({
      counts: {
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
      },
      totalLeds: 4,
    });

    const flow = createDefaultTestPatternFlow(async () => pendingConnection, emptyConfig);
    const togglePromise = flow.toggle(true);

    rafCallback(1_130);
    resolveConnection({ connected: true });
    const snapshot = await togglePromise;

    expect(snapshot.markerIndex).toBe(1);
    expect(startCalibrationTestPatternMock).toHaveBeenCalledTimes(1);
    expect(startCalibrationTestPatternMock).toHaveBeenLastCalledWith({
      ledIndexes: [snapshot.markerIndex],
      frameMs: 120,
      brightness: 64,
    });

    nowSpy.mockRestore();
  });
});
