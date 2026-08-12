/**
 * Twin-overlay LED geometry.
 *
 * The digital-twin overlay must render LED #N at the same physical screen
 * edge position the real strip LED #N occupies. The canonical strip order is
 * owned by `buildLedSequence` (calibration/model/indexMapping) — the SAME
 * function the calibration editor + synthetic test generator consume — so we
 * REUSE it here verbatim instead of re-deriving the index→edge mapping. That
 * guarantees `twin LED #N === strip LED #N` (the highest-correctness
 * requirement of the overlay).
 *
 * `buildLedSequence` returns items in strip order (anchor-rotated, direction
 * applied). The enriched `EdgeSignalPayload.leds` buffer is emitted in that
 * exact same order, so the array position here IS the strip index that indexes
 * into `leds`. Each item also carries `{ segment, localIndex }` — the canonical
 * per-edge local coordinate, oriented exactly as documented in
 * `LedRoomCanvas.tsx`:
 *
 *   - Top edge:    local 0 = LEFT,   n-1 = RIGHT  (L → R)
 *   - Right edge:  local 0 = TOP,    m-1 = BOTTOM (T → B)
 *   - Bottom edge: local 0 = RIGHT,  p-1 = LEFT   (R → L)
 *   - Left edge:   local 0 = BOTTOM, q-1 = TOP    (B → T)
 *
 * We map each canonical local coordinate to a normalized 0..1 position on the
 * overlay viewport perimeter. The bottom-gap packing mirrors
 * `LedRoomCanvas.computeBottomDotXs` (left half packed from the left, right
 * half packed from the right, gap centred) so a bottom-gap strip lands its
 * dots where the physical strip does.
 */

import { buildLedSequence } from "../calibration/model/indexMapping";
import type {
  LedCalibrationConfig,
  LedSegmentKey,
} from "../calibration/model/contracts";

/** How far the dot row sits in from the viewport edge (fraction of W/H). */
const EDGE_INSET = 0.022;
/** Padding from each corner so adjacent edges do not collide visually. */
const CORNER_INSET = 0.05;

/** One strip LED's normalized perimeter position on the twin overlay. */
export interface TwinLedPosition {
  /**
   * Strip index — `twin LED #N === strip LED #N`. Indexes directly into the
   * enriched `EdgeSignalPayload.leds` buffer.
   */
  index: number;
  /** Which calibrated edge this LED lives on. */
  edge: LedSegmentKey;
  /** Normalized 0..1 X across the display viewport (0 = left, 1 = right). */
  x: number;
  /** Normalized 0..1 Y across the display viewport (0 = top, 1 = bottom). */
  y: number;
}

/** Evenly spread `count` points across [lo, hi] (inclusive endpoints). */
function spread(count: number, lo: number, hi: number): number[] {
  if (count <= 0) return [];
  if (count === 1) return [(lo + hi) / 2];
  const step = (hi - lo) / (count - 1);
  return Array.from({ length: count }, (_, i) => lo + step * i);
}

/**
 * Bottom-edge X coordinates in LEFT→RIGHT order, honouring `bottomMissing`.
 * Mirrors `LedRoomCanvas.computeBottomDotXs` exactly so the gap geometry
 * matches the calibration editor + physical strip.
 */
function bottomXs(count: number, missing: number, lo: number, hi: number): number[] {
  if (count <= 0) return [];
  if (missing <= 0) return spread(count, lo, hi);

  const totalSlots = count + missing;
  if (totalSlots <= 1) return spread(count, lo, hi);

  const step = (hi - lo) / (totalSlots - 1);
  const leftHalf = Math.floor(count / 2);
  const out: number[] = [];
  for (let i = 0; i < leftHalf; i += 1) out.push(lo + step * i);
  for (let i = 0; i < count - leftHalf; i += 1) {
    out.push(lo + step * (leftHalf + missing + i));
  }
  return out;
}

/**
 * Compute normalized perimeter positions for every LED, in strip order.
 * `result[N]` is the screen position of strip LED #N.
 */
export function computeTwinLedPositions(config: LedCalibrationConfig): TwinLedPosition[] {
  const sequence = buildLedSequence(config);
  const { counts, bottomMissing } = config;

  const hi = 1 - CORNER_INSET;
  const lo = CORNER_INSET;
  const topXs = spread(counts.top, lo, hi);
  const rightYs = spread(counts.right, lo, hi);
  const leftYs = spread(counts.left, lo, hi);
  const botXs = bottomXs(counts.bottom, bottomMissing, lo, hi);

  return sequence.map((item, stripIndex) => {
    const { segment, localIndex } = item;
    switch (segment) {
      case "top":
        return {
          index: stripIndex,
          edge: segment,
          x: topXs[localIndex] ?? 0.5,
          y: EDGE_INSET,
        };
      case "right":
        return {
          index: stripIndex,
          edge: segment,
          x: 1 - EDGE_INSET,
          y: rightYs[localIndex] ?? 0.5,
        };
      case "bottom":
        // canonical local 0 = RIGHT → reverse the L→R array.
        return {
          index: stripIndex,
          edge: segment,
          x: botXs[botXs.length - 1 - localIndex] ?? 0.5,
          y: 1 - EDGE_INSET,
        };
      case "left":
      default:
        // canonical local 0 = BOTTOM → reverse the T→B array.
        return {
          index: stripIndex,
          edge: segment,
          x: EDGE_INSET,
          y: leftYs[leftYs.length - 1 - localIndex] ?? 0.5,
        };
    }
  });
}
