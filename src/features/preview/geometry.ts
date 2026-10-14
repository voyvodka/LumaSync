/**
 * Twin-overlay LED geometry.
 *
 * The twin draws strip LED #N where LED #N takes its colour from. Two things
 * are shared with the backend rather than re-derived here:
 *
 *   - strip order: `buildLedSequence` (calibration/model/indexMapping), the
 *     mirror of `build_led_sequence` in led_calibration.rs. A twin frame's
 *     LEDs come in that order, so the array position here IS the strip index
 *     into `leds`.
 *   - screen position: `ledScreenPosition`, the mirror of `led_to_screen_pos`,
 *     where the worker centres each LED's sampling window.
 *
 * Both are pinned by one golden fixture, `__tests__/ledScreenGeometry.golden.json`,
 * read by vitest and by `cargo test`: a change on one side fails the other
 * side's test until the fixture and both implementations move together.
 *
 * Canonical per-edge local coordinates (see `led_to_screen_pos` in led_calibration.rs):
 *
 *   - Top edge:    local 0 = LEFT,   n-1 = RIGHT  (L → R)
 *   - Right edge:  local 0 = TOP,    m-1 = BOTTOM (T → B)
 *   - Bottom edge: local 0 = RIGHT,  p-1 = LEFT   (R → L)
 *   - Left edge:   local 0 = BOTTOM, q-1 = TOP    (B → T)
 *
 * Each edge's LED pitches spread end to end; the bottom counts the stand gap
 * (`bottomMissing`) among its pitches, so its LEDs sit either side of the gap
 * where LED Setup draws them — and sample the screen above where they are.
 */

import { buildLedSequence, type LedSequenceItem } from "../calibration/model/indexMapping";
import type { LedCalibrationConfig, LedSegmentKey } from "../calibration/model/contracts";
import { gapRightCount } from "../calibration/model/startPoint";

/** What an LED's place depends on: the edge counts and the stand gap. */
export type StripPlacement = Pick<LedCalibrationConfig, "counts" | "bottomMissing">;

/** How far the dot row sits in from the viewport edge (fraction of W/H). */
const EDGE_INSET = 0.022;
/** Padding from each corner so adjacent edges do not collide visually. */
const CORNER_INSET = 0.05;

export interface TwinLedPosition {
  /**
   * Strip index — `twin LED #N === strip LED #N`. Indexes directly into a
   * twin frame's `leds`.
   */
  index: number;
  /** Which calibrated edge this LED lives on. */
  edge: LedSegmentKey;
  /** Normalized 0..1 X across the display viewport (0 = left, 1 = right). */
  x: number;
  /** Normalized 0..1 Y across the display viewport (0 = top, 1 = bottom). */
  y: number;
}

/**
 * Normalized centre of the screen window an LED samples, `(0, 0)` top-left.
 * A one-LED edge sits at its middle, as it does in the backend and in LED Setup.
 */
export function ledScreenPosition(
  item: Pick<LedSequenceItem, "segment" | "localIndex">,
  { counts, bottomMissing }: StripPlacement,
): { x: number; y: number } {
  const count = counts[item.segment];
  // A gap needs an LED on each side; the bottom runs right to left, and the
  // LEDs past the right-hand run sit beyond it.
  const gap = item.segment === "bottom" && count >= 2 ? bottomMissing : 0;
  const pitches = count + gap;
  const pitch = gap > 0 && item.localIndex >= gapRightCount(count) ? item.localIndex + gap : item.localIndex;
  const frac = pitches <= 1 ? 0.5 : pitch === 0 ? 0 : pitch / (pitches - 1);
  switch (item.segment) {
    case "top":
      return { x: frac, y: 0 };
    case "right":
      return { x: 1, y: frac };
    case "bottom":
      return { x: 1 - frac, y: 1 };
    case "left":
    default:
      return { x: 0, y: 1 - frac };
  }
}

/** Along an edge, pulled in from the corners so neighbouring edges' dots do not touch. */
function alongEdge(value: number): number {
  return CORNER_INSET + value * (1 - 2 * CORNER_INSET);
}

/** Across an edge, pinned just inside the viewport border. */
function acrossEdge(value: number): number {
  return EDGE_INSET + value * (1 - 2 * EDGE_INSET);
}

/**
 * Compute normalized perimeter positions for every LED, in strip order.
 * `result[N]` is the screen position of strip LED #N.
 */
export function computeTwinLedPositions(config: LedCalibrationConfig): TwinLedPosition[] {
  return buildLedSequence(config).map((item, stripIndex) => {
    const { x, y } = ledScreenPosition(item, config);
    const horizontal = item.segment === "top" || item.segment === "bottom";
    return {
      index: stripIndex,
      edge: item.segment,
      x: horizontal ? alongEdge(x) : acrossEdge(x),
      y: horizontal ? acrossEdge(y) : alongEdge(y),
    };
  });
}
