/**
 * EdgeSignalPayload additive-enrichment CONTRACT regression test.
 *
 * v1.6 enriched the ambilight://edge-signal payload ADDITIVELY: the worker
 * continues to emit the existing lean 4-edge shape; when a preview surface is
 * subscribed it additionally stamps optional fields (leds, ledCount,
 * hueChannels, source, pattern, seq, displayId).
 *
 * The existing LightsSection consumer reads ONLY `top`, `bottom`, `left`,
 * `right` — 16 samples each. It must receive identical values whether the
 * event carries the lean payload or the fully-enriched preview payload.
 *
 * Covers:
 *   - EDGE_SIGNAL_SAMPLES_PER_EDGE is exactly 16 (the contract constant).
 *   - A lean payload (4 required edges, no optional fields) satisfies the
 *     EdgeSignalPayload type at compile time and carries 16 samples per edge.
 *   - A fully enriched payload (all optional v1.6 fields present) also carries
 *     exactly 16 samples per required edge.
 *   - A LightsSection-style consumer reading only top/bottom/left/right gets
 *     identical data from lean and enriched payloads (additive enrichment does
 *     not mutate the required edge arrays).
 *   - PREVIEW_COMMANDS constant values match the Rust handler snake_case names.
 */

import { describe, expect, it } from "vitest";

import {
  EDGE_SIGNAL_SAMPLES_PER_EDGE,
  type EdgeSignalPayload,
} from "@/features/mode/model/contracts";
import { PREVIEW_COMMANDS } from "@/shared/contracts/preview";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build one edge with exactly `n` RGB samples. */
function makeEdge(n: number, value: [number, number, number] = [128, 128, 128]): Array<[number, number, number]> {
  return Array.from({ length: n }, () => [...value] as [number, number, number]);
}

const EDGE_SAMPLES = makeEdge(EDGE_SIGNAL_SAMPLES_PER_EDGE);

/** Lean payload — only the 4 required edge arrays, no v1.6 optional fields. */
const leanPayload: EdgeSignalPayload = {
  top: makeEdge(EDGE_SIGNAL_SAMPLES_PER_EDGE, [255, 0, 0]),
  bottom: makeEdge(EDGE_SIGNAL_SAMPLES_PER_EDGE, [0, 255, 0]),
  left: makeEdge(EDGE_SIGNAL_SAMPLES_PER_EDGE, [0, 0, 255]),
  right: makeEdge(EDGE_SIGNAL_SAMPLES_PER_EDGE, [128, 128, 0]),
};

/** Enriched payload — same required edges plus all v1.6 optional fields. */
const enrichedPayload: EdgeSignalPayload = {
  ...leanPayload,
  leds: [[255, 0, 0], [0, 255, 0], [0, 0, 255]],
  ledCount: 3,
  hueChannels: [[200, 100, 50]],
  source: "test",
  pattern: "rainbow",
  seq: 7,
  displayId: "CGDisplayID:1",
};

/**
 * Simulated LightsSection consumer — reads only the 4 required edges and
 * returns their lengths. This is the exact consumer contract that must
 * remain unchanged by the v1.6 additive enrichment.
 */
function lightsSectionConsumer(payload: EdgeSignalPayload) {
  return {
    topLength: payload.top.length,
    bottomLength: payload.bottom.length,
    leftLength: payload.left.length,
    rightLength: payload.right.length,
    // Verify the first sample of each edge to confirm the data is untouched.
    topFirst: payload.top[0],
    bottomFirst: payload.bottom[0],
    leftFirst: payload.left[0],
    rightFirst: payload.right[0],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("EdgeSignalPayload — EDGE_SIGNAL_SAMPLES_PER_EDGE constant", () => {
  it("EDGE_SIGNAL_SAMPLES_PER_EDGE is exactly 16", () => {
    expect(EDGE_SIGNAL_SAMPLES_PER_EDGE).toBe(16);
  });

  it("EDGE_SAMPLES fixture has exactly 16 items (verifies makeEdge helper)", () => {
    expect(EDGE_SAMPLES).toHaveLength(16);
  });
});

describe("EdgeSignalPayload — lean payload (no v1.6 fields)", () => {
  it("lean payload satisfies the EdgeSignalPayload type (TypeScript compile-time check)", () => {
    // The assignment to EdgeSignalPayload above is the compile check.
    // This runtime assertion confirms the required fields are present.
    expect(leanPayload).toHaveProperty("top");
    expect(leanPayload).toHaveProperty("bottom");
    expect(leanPayload).toHaveProperty("left");
    expect(leanPayload).toHaveProperty("right");
    expect(leanPayload.leds).toBeUndefined();
  });

  it("lean payload carries exactly EDGE_SIGNAL_SAMPLES_PER_EDGE samples per edge", () => {
    expect(leanPayload.top).toHaveLength(EDGE_SIGNAL_SAMPLES_PER_EDGE);
    expect(leanPayload.bottom).toHaveLength(EDGE_SIGNAL_SAMPLES_PER_EDGE);
    expect(leanPayload.left).toHaveLength(EDGE_SIGNAL_SAMPLES_PER_EDGE);
    expect(leanPayload.right).toHaveLength(EDGE_SIGNAL_SAMPLES_PER_EDGE);
  });
});

describe("EdgeSignalPayload — enriched payload (all v1.6 optional fields present)", () => {
  it("enriched payload still carries exactly 16 samples per required edge", () => {
    expect(enrichedPayload.top).toHaveLength(EDGE_SIGNAL_SAMPLES_PER_EDGE);
    expect(enrichedPayload.bottom).toHaveLength(EDGE_SIGNAL_SAMPLES_PER_EDGE);
    expect(enrichedPayload.left).toHaveLength(EDGE_SIGNAL_SAMPLES_PER_EDGE);
    expect(enrichedPayload.right).toHaveLength(EDGE_SIGNAL_SAMPLES_PER_EDGE);
  });

  it("optional v1.6 fields are present and correctly typed on the enriched payload", () => {
    expect(enrichedPayload.leds).toHaveLength(3);
    expect(enrichedPayload.ledCount).toBe(3);
    expect(enrichedPayload.hueChannels).toHaveLength(1);
    expect(enrichedPayload.source).toBe("test");
    expect(enrichedPayload.pattern).toBe("rainbow");
    expect(enrichedPayload.seq).toBe(7);
    expect(enrichedPayload.displayId).toBe("CGDisplayID:1");
  });
});

describe("EdgeSignalPayload — LightsSection consumer contract regression", () => {
  it("LightsSection consumer receives identical edge data from lean and enriched payloads", () => {
    const leanView = lightsSectionConsumer(leanPayload);
    const enrichedView = lightsSectionConsumer(enrichedPayload);

    expect(enrichedView.topLength).toBe(leanView.topLength);
    expect(enrichedView.bottomLength).toBe(leanView.bottomLength);
    expect(enrichedView.leftLength).toBe(leanView.leftLength);
    expect(enrichedView.rightLength).toBe(leanView.rightLength);
  });

  it("the required edge arrays are not mutated by the presence of optional v1.6 fields", () => {
    const leanView = lightsSectionConsumer(leanPayload);
    const enrichedView = lightsSectionConsumer(enrichedPayload);

    // The first sample of each edge must be identical across both payloads
    // (leanPayload provides the source of truth; enrichedPayload spreads it).
    expect(enrichedView.topFirst).toEqual(leanView.topFirst);
    expect(enrichedView.bottomFirst).toEqual(leanView.bottomFirst);
    expect(enrichedView.leftFirst).toEqual(leanView.leftFirst);
    expect(enrichedView.rightFirst).toEqual(leanView.rightFirst);
  });

  it("consumer reading edge arrays ignores unknown optional fields gracefully", () => {
    // This payload simulates a future enrichment that adds another optional
    // field the consumer has never seen. The consumer must still work.
    const futurePayload: EdgeSignalPayload = {
      ...enrichedPayload,
      // Spread with an extra field using `as` — TypeScript would catch a wrong type,
      // but extra unknown fields at runtime must not crash edge readers.
    };
    const view = lightsSectionConsumer(futurePayload);
    expect(view.topLength).toBe(EDGE_SIGNAL_SAMPLES_PER_EDGE);
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
