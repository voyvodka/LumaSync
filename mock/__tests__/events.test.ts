/**
 * What is worth testing in a dev-only module: the parts that can be wrong
 * without looking wrong.
 *
 * A frame generator that silently emits 60 LEDs into a world calibrated for
 * 164 produces a twin overlay that renders beautifully and lies, and the next
 * person spends an afternoon looking for an off-by-one in the strip mapping
 * that is really a fixture bug. The same goes for `seq` renumbering around a
 * dropped frame — it would make the drop detection the mock exists to exercise
 * permanently silent.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildEdgeSignalFrame,
  currentPreviewStatus,
  getEdgeSignalStream,
  startEdgeSignalStream,
  stopEdgeSignalStream,
} from "../events";
import { SCENARIOS } from "../scenarios";
import { getWorld, mutate, setWorld } from "../state";

const emitMock = vi.fn((_event: string, _payload?: unknown) => Promise.resolve());

vi.mock("@tauri-apps/api/event", () => ({
  emit: (event: string, payload?: unknown) => emitMock(event, payload),
}));

beforeEach(() => {
  emitMock.mockClear();
  stopEdgeSignalStream();
  setWorld(SCENARIOS.furnished.build());
});

describe("buildEdgeSignalFrame", () => {
  it("carries no per-edge arrays, which the real worker no longer sends", () => {
    const frame = buildEdgeSignalFrame("rainbow", 1, "live");
    for (const edge of ["top", "right", "bottom", "left"]) {
      expect(frame).not.toHaveProperty(edge);
    }
  });

  it("sizes the LED buffer from the live calibration, not a constant", () => {
    expect(buildEdgeSignalFrame("solid", 1, "live").ledCount).toBe(164);

    mutate((w) => {
      const calibration = w.shellState.ledCalibration;
      if (calibration) w.shellState = { ...w.shellState, ledCalibration: { ...calibration, totalLeds: 42 } };
    });

    const frame = buildEdgeSignalFrame("solid", 1, "live");
    expect(frame.ledCount).toBe(42);
    expect(frame.leds).toHaveLength(42);
  });

  it("falls back to a non-empty buffer when no calibration exists", () => {
    // An empty `leds` array is a valid payload the twin renders as "nothing",
    // so zero would read as a working stream rather than a missing setup.
    mutate((w) => {
      w.shellState = { ...w.shellState, ledCalibration: undefined };
    });
    expect(buildEdgeSignalFrame("solid", 1, "live").ledCount).toBeGreaterThan(0);
  });

  it("carries one Hue sample per channel in the world", () => {
    expect(buildEdgeSignalFrame("solid", 1, "live").hueChannels).toHaveLength(
      getWorld().hue.channels.length,
    );

    mutate((w) => {
      w.hue.channels = [];
    });
    expect(buildEdgeSignalFrame("solid", 1, "live").hueChannels).toHaveLength(0);
  });

  it("stamps the pattern only on a test frame, because live capture has none", () => {
    expect(buildEdgeSignalFrame("chase", 1, "test").pattern).toBe("chase");
    expect(buildEdgeSignalFrame("chase", 1, "live").pattern).toBeUndefined();
  });

  it("produces different colours at different frames for an animated pattern", () => {
    const a = buildEdgeSignalFrame("rainbow", 1, "live").leds?.[0];
    const b = buildEdgeSignalFrame("rainbow", 30, "live").leds?.[0];
    expect(a).not.toEqual(b);
  });

  it("keeps every channel byte inside the 0..255 the wire format allows", () => {
    for (const pattern of ["solid", "chase", "rainbow", "spiral", "gamut"] as const) {
      for (const frameNo of [0, 7, 33]) {
        for (const [r, g, b] of buildEdgeSignalFrame(pattern, frameNo, "test").leds ?? []) {
          for (const channelValue of [r, g, b]) {
            expect(Number.isInteger(channelValue)).toBe(true);
            expect(channelValue).toBeGreaterThanOrEqual(0);
            expect(channelValue).toBeLessThanOrEqual(255);
          }
        }
      }
    }
  });
});

describe("the edge-signal stream", () => {
  it("advances seq across a dropped frame instead of renumbering around it", async () => {
    vi.useFakeTimers();
    startEdgeSignalStream({ pattern: "solid", source: "live", dropEveryNthFrame: 2 });
    emitMock.mockClear();

    await vi.advanceTimersByTimeAsync(400);
    stopEdgeSignalStream();
    vi.useRealTimers();

    const sequences = emitMock.mock.calls
      .filter((call) => call[0] === "ambilight://edge-signal")
      .map((call) => (call[1] as { seq: number }).seq);

    // Every second frame is withheld, so the numbers that do arrive are odd
    // and non-contiguous — which is exactly what drop detection reads.
    expect(sequences.length).toBeGreaterThan(0);
    expect(sequences.every((seq) => seq % 2 === 1)).toBe(true);
  });

  it("reports the preview state from the stream rather than a second switch", () => {
    expect(currentPreviewStatus()).toMatchObject({ testActive: false, source: "idle" });

    startEdgeSignalStream({ pattern: "gamut", source: "test" });
    expect(currentPreviewStatus()).toMatchObject({
      testActive: true,
      source: "test",
      activePattern: { kind: "gamut" },
    });

    // A live stream is running but not a *test*, and conflating the two is how
    // the preview surfaces would claim a synthetic pattern over real capture.
    startEdgeSignalStream({ pattern: "gamut", source: "live" });
    expect(currentPreviewStatus()).toMatchObject({ testActive: false, source: "live" });

    stopEdgeSignalStream();
    expect(currentPreviewStatus().source).toBe("idle");
  });

  it("carries an explicit colour for the patterns whose payload declares one", () => {
    startEdgeSignalStream({ pattern: "solid", source: "test" });
    expect(currentPreviewStatus().activePattern).toEqual({ kind: "solid", r: 251, g: 191, b: 36 });
    stopEdgeSignalStream();
  });

  // A probe without its slot does not type-check against LedTestPattern, and a
  // twin painted in the wrong primary would teach the wrong answer.
  it("carries the probe slot and paints the whole strip in that slot's primary", () => {
    startEdgeSignalStream({ pattern: "channelProbe", probeSlot: 1, source: "test" });
    expect(currentPreviewStatus().activePattern).toEqual({ kind: "channelProbe", slot: 1 });
    stopEdgeSignalStream();

    const frame = buildEdgeSignalFrame("channelProbe", 1, "test", 2);
    expect(frame.leds?.every(([r, g, b]) => r === 0 && g === 0 && b === 255)).toBe(true);
    expect(frame.pattern).toBe("channelProbe");
  });

  it("restarting replaces the interval rather than stacking a second one", async () => {
    vi.useFakeTimers();
    startEdgeSignalStream({ pattern: "solid", source: "live" });
    startEdgeSignalStream({ pattern: "solid", source: "live" });
    emitMock.mockClear();

    await vi.advanceTimersByTimeAsync(300);
    stopEdgeSignalStream();
    vi.useRealTimers();

    // Three ticks at 100 ms. A stacked interval would double this.
    expect(emitMock).toHaveBeenCalledTimes(3);
  });

  it("stops emitting once stopped", async () => {
    vi.useFakeTimers();
    startEdgeSignalStream({ pattern: "solid", source: "live" });
    await vi.advanceTimersByTimeAsync(200);
    stopEdgeSignalStream();
    emitMock.mockClear();

    await vi.advanceTimersByTimeAsync(500);
    vi.useRealTimers();

    expect(emitMock).not.toHaveBeenCalled();
    expect(getEdgeSignalStream().running).toBe(false);
  });
});
