/**
 * The strip geometry shared with the backend. `ledScreenGeometry.golden.json`
 * is also read by `led_screen_geometry_matches_the_shared_golden_fixture` in
 * src-tauri/src/commands/led_calibration.rs, so both sides are held to one
 * answer: strip order from `buildLedSequence` / `build_led_sequence`, and
 * sampling position from `ledScreenPosition` / `led_to_screen_pos`.
 */

import { describe, expect, it } from "vitest";

import type { LedCalibrationConfig, LedSegmentKey } from "@/features/calibration/model/contracts";
import { buildLedSequence } from "@/features/calibration/model/indexMapping";
import { computeTwinLedPositions, ledScreenPosition } from "../geometry";
import golden from "./ledScreenGeometry.golden.json";

type GoldenLed = [LedSegmentKey, number, number, number];

interface GoldenCase {
  name: string;
  config: LedCalibrationConfig;
  leds: GoldenLed[];
}

const cases = golden.cases as unknown as GoldenCase[];

describe("LED screen geometry — shared golden fixture", () => {
  it("covers every start anchor in both directions, a bottom gap and uneven counts", () => {
    const anchors = new Set(cases.map((c) => `${c.config.startAnchor}/${c.config.direction}`));
    for (const anchor of [
      "top-start",
      "top-end",
      "right-start",
      "right-end",
      "bottom-start",
      "bottom-end",
      "bottom-gap-right",
      "bottom-gap-left",
      "left-start",
      "left-end",
    ]) {
      expect(anchors.has(`${anchor}/cw`)).toBe(true);
      expect(anchors.has(`${anchor}/ccw`)).toBe(true);
    }
    expect(cases.some((c) => c.config.bottomMissing > 0)).toBe(true);
    expect(
      cases.some((c) => new Set(Object.values(c.config.counts)).size === 4),
    ).toBe(true);
  });

  it.each(cases.map((c) => [c.name, c] as const))("%s", (_name, golden) => {
    const sequence = buildLedSequence(golden.config);
    expect(sequence).toHaveLength(golden.leds.length);
    sequence.forEach((item, stripIndex) => {
      const [segment, localIndex, x, y] = golden.leds[stripIndex]!;
      const where = `strip LED #${stripIndex}`;
      expect({ segment: item.segment, localIndex: item.localIndex }, where).toEqual({
        segment,
        localIndex,
      });
      const position = ledScreenPosition(item, golden.config.counts);
      expect(position.x, `${where} x`).toBeCloseTo(x, 5);
      expect(position.y, `${where} y`).toBeCloseTo(y, 5);
    });
  });

  it("draws every twin dot on its LED's sampling position, pulled in from the viewport edge", () => {
    for (const golden of cases) {
      const twin = computeTwinLedPositions(golden.config);
      twin.forEach((dot, stripIndex) => {
        const [segment, , x, y] = golden.leds[stripIndex]!;
        expect(dot.edge).toBe(segment);
        const horizontal = segment === "top" || segment === "bottom";
        // The twin's insets are a monotone affine pull-in of the sampling
        // position, so the order and spacing along each edge must survive.
        const along = horizontal ? dot.x : dot.y;
        const sampled = horizontal ? x : y;
        expect(along).toBeCloseTo(0.05 + sampled * 0.9, 5);
      });
    }
  });
});
