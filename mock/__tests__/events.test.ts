/**
 * What is worth testing in a dev-only module: the parts that can be wrong
 * without looking wrong.
 *
 * A frame generator that silently emits 60 LEDs into a world calibrated for
 * 164 produces a twin that renders beautifully and lies, and the next person
 * spends an afternoon looking for an off-by-one in the strip mapping that is
 * really a fixture bug. The same goes for `seq` renumbering around a dropped
 * frame — it would make the drop handling the mock exists to exercise
 * permanently silent.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { decodeTwinFrame } from "../../src/features/preview/twinFrame";
import {
  attachTwinChannel,
  buildTwinFrame,
  encodeTwinFrame,
  getTwinFrameStream,
  mockTwinLayout,
  startTwinFrameStream,
  stopTwinFrameStream,
} from "../events";
import { SCENARIOS } from "../scenarios";
import { getWorld, mutate, setWorld } from "../state";

vi.mock("@tauri-apps/api/event", () => ({ emit: () => Promise.resolve() }));

const received: ArrayBuffer[] = [];

beforeEach(() => {
  received.length = 0;
  stopTwinFrameStream();
  setWorld(SCENARIOS.furnished.build());
  attachTwinChannel({ onmessage: (frame) => received.push(frame) });
});

describe("buildTwinFrame", () => {
  it("sizes the LED buffer from the live calibration, not a constant", () => {
    expect(buildTwinFrame("solid", 1).leds).toHaveLength(164);

    mutate((w) => {
      w.shellState = {
        ...w.shellState,
        ledStrips: (w.shellState.ledStrips ?? []).map((strip) =>
          strip.layout ? { ...strip, layout: { ...strip.layout, totalLeds: 42 } } : strip,
        ),
      };
    });

    expect(buildTwinFrame("solid", 1).leds).toHaveLength(42);
    expect(mockTwinLayout().leds?.totalLeds).toBe(42);
  });

  it("falls back to a non-empty buffer when no calibration exists", () => {
    // An empty buffer is a valid frame the twin renders as "nothing", so zero
    // would read as a working stream rather than a missing setup.
    mutate((w) => {
      w.shellState = { ...w.shellState, ledStrips: [] };
    });
    expect(buildTwinFrame("solid", 1).leds.length).toBeGreaterThan(0);
  });

  it("carries one lamp per Hue channel in the world", () => {
    expect(buildTwinFrame("solid", 1).lamps).toHaveLength(getWorld().hue.channels.length);

    mutate((w) => {
      w.hue.channels = [];
    });
    expect(buildTwinFrame("solid", 1).lamps).toHaveLength(0);
  });

  it("produces different colours at different frames for an animated pattern", () => {
    expect(buildTwinFrame("rainbow", 1).leds[0]).not.toEqual(buildTwinFrame("rainbow", 30).leds[0]);
  });

  // A twin painted in the wrong primary would teach the wrong answer.
  it("paints the whole strip in the probe slot's primary", () => {
    expect(buildTwinFrame("channelProbe", 1, 2).leds.every(([r, g, b]) => r === 0 && g === 0 && b === 255)).toBe(
      true,
    );
  });

  it("encodes a frame the twin's own decoder reads back", () => {
    const frame = buildTwinFrame("gamut", 3);
    expect(decodeTwinFrame(encodeTwinFrame(9, frame))).toEqual({
      seq: 9,
      layoutRevision: mockTwinLayout().layoutRevision,
      leds: frame.leds,
      lamps: frame.lamps,
    });
  });
});

describe("the twin frame stream", () => {
  const seqs = () => received.map((buffer) => decodeTwinFrame(buffer)?.seq ?? -1);

  it("advances seq across a dropped frame instead of renumbering around it", async () => {
    vi.useFakeTimers();
    startTwinFrameStream({ pattern: "solid", dropEveryNthFrame: 2 });
    await vi.advanceTimersByTimeAsync(400);
    stopTwinFrameStream();
    vi.useRealTimers();

    // Every second frame is withheld, so the numbers that do arrive are odd
    // and non-contiguous.
    expect(received.length).toBeGreaterThan(0);
    expect(seqs().every((seq) => seq % 2 === 1)).toBe(true);
  });

  it("restarting replaces the interval rather than stacking a second one", async () => {
    vi.useFakeTimers();
    const framesIn300Ms = async () => {
      received.length = 0;
      await vi.advanceTimersByTimeAsync(300);
      return received.length;
    };
    startTwinFrameStream({ pattern: "solid" });
    const single = await framesIn300Ms();
    startTwinFrameStream({ pattern: "solid" });
    startTwinFrameStream({ pattern: "solid" });
    const restarted = await framesIn300Ms();
    stopTwinFrameStream();
    vi.useRealTimers();

    // A stacked interval would double this.
    expect(single).toBeGreaterThan(0);
    expect(restarted).toBe(single);
  });

  it("stops sending once stopped", async () => {
    vi.useFakeTimers();
    startTwinFrameStream({ pattern: "solid" });
    await vi.advanceTimersByTimeAsync(200);
    stopTwinFrameStream();
    received.length = 0;

    await vi.advanceTimersByTimeAsync(500);
    vi.useRealTimers();

    expect(received).toHaveLength(0);
    expect(getTwinFrameStream().running).toBe(false);
  });
});
