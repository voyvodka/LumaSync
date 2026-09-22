/**
 * EdgeSignalPayload contract regression test.
 *
 * `ambilight://edge-signal` feeds only the LED twin overlay. The Rust worker
 * builds it only while a twin is open and serialises the per-LED buffer plus
 * its metadata (leds, ledCount, hueChannels, source, pattern, seq, displayId).
 * The four 16-sample edge arrays (top/bottom/left/right) were dropped once the
 * Lights page edge preview — their only reader — was removed.
 *
 * Covers:
 *   - A frame shaped like the Rust serialisation satisfies the type.
 *   - The dropped edge arrays are no longer part of the type (compile-time).
 *   - PREVIEW_COMMANDS constant values match the Rust handler snake_case names.
 */

import { describe, expect, it } from "vitest";

import type { EdgeSignalPayload } from "@/features/mode/model/contracts";
import { PREVIEW_COMMANDS } from "@/shared/contracts/preview";

/** Mirrors what `EdgeSignalPayload` in `lighting_mode.rs` serialises. */
const twinFrame: EdgeSignalPayload = {
  leds: [[255, 0, 0], [0, 255, 0], [0, 0, 255]],
  ledCount: 3,
  hueChannels: [[200, 100, 50]],
  source: "live",
  seq: 7,
  displayId: "display-1",
};

describe("EdgeSignalPayload — twin-only shape", () => {
  it("carries the per-LED buffer and the Hue channel colours the twin renders", () => {
    expect(twinFrame.leds).toHaveLength(twinFrame.ledCount ?? -1);
    expect(twinFrame.hueChannels).toHaveLength(1);
  });

  it("no longer declares the dropped edge arrays", () => {
    const withEdges: EdgeSignalPayload = {
      ...twinFrame,
      // @ts-expect-error — `top` was dropped with its only reader.
      top: [],
    };
    expect(Object.keys(twinFrame)).not.toContain("top");
    expect(withEdges.leds).toBe(twinFrame.leds);
  });
});

describe("PREVIEW_COMMANDS — Rust snake_case name regression", () => {
  it("START_TEST_PATTERN maps to the Rust handler name start_led_test_pattern", () => {
    expect(PREVIEW_COMMANDS.START_TEST_PATTERN).toBe("start_led_test_pattern");
  });

  it("STOP_TEST_PATTERN maps to stop_led_test_pattern", () => {
    expect(PREVIEW_COMMANDS.STOP_TEST_PATTERN).toBe("stop_led_test_pattern");
  });

  it("GET_PREVIEW_STATUS maps to get_led_preview_status", () => {
    expect(PREVIEW_COMMANDS.GET_PREVIEW_STATUS).toBe("get_led_preview_status");
  });

  it("OPEN_TWIN_OVERLAY maps to open_led_twin_overlay", () => {
    expect(PREVIEW_COMMANDS.OPEN_TWIN_OVERLAY).toBe("open_led_twin_overlay");
  });

  it("CLOSE_TWIN_OVERLAY maps to close_led_twin_overlay", () => {
    expect(PREVIEW_COMMANDS.CLOSE_TWIN_OVERLAY).toBe("close_led_twin_overlay");
  });

  it("OPEN_CONTROL_POPUP maps to open_led_control_popup", () => {
    expect(PREVIEW_COMMANDS.OPEN_CONTROL_POPUP).toBe("open_led_control_popup");
  });

  it("SHOW_CONTROL_POPUP maps to show_led_control_popup", () => {
    expect(PREVIEW_COMMANDS.SHOW_CONTROL_POPUP).toBe("show_led_control_popup");
  });

  it("HIDE_CONTROL_POPUP maps to hide_led_control_popup", () => {
    expect(PREVIEW_COMMANDS.HIDE_CONTROL_POPUP).toBe("hide_led_control_popup");
  });
});
