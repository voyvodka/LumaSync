/**
 * LED calibration contracts for frontend <-> backend command bridge.
 *
 * Extracted from `features/calibration/model/contracts.ts` so that
 * shared shell / persistence layers can depend on the calibration
 * surface without importing from a feature module. Feature-level
 * normalization helpers continue to live next to the feature code;
 * this file only re-publishes the cross-layer types and constant
 * string unions that act as contracts.
 */

// ---------------------------------------------------------------------------
// Calibration primitives
// ---------------------------------------------------------------------------

export type LedDirection = "cw" | "ccw";

export type CornerOwnership = "horizontal" | "vertical";

export type LedVisualPreset = "subtle" | "vivid";

export type LedSegmentKey = "top" | "right" | "bottom" | "left";

export type LedStartAnchor =
  | "top-start"
  | "top-end"
  | "right-start"
  | "right-end"
  | "bottom-start"
  | "bottom-end"
  | "bottom-gap-right"
  | "bottom-gap-left"
  | "left-start"
  | "left-end";

export interface LedSegmentCounts {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/**
 * Persisted LED calibration model. Stored under `ShellState.ledCalibration`
 * and consumed by capture, preview, and mode runtime surfaces.
 */
export interface LedCalibrationConfig {
  templateId?: string;
  counts: LedSegmentCounts;
  bottomMissing: number;
  cornerOwnership: CornerOwnership;
  visualPreset: LedVisualPreset;
  startAnchor: LedStartAnchor;
  direction: LedDirection;
  totalLeds: number;
}

export interface CalibrationTemplate {
  id: string;
  label: string;
  counts: LedSegmentCounts;
  bottomMissing: number;
  cornerOwnership: CornerOwnership;
  visualPreset: LedVisualPreset;
  startAnchor: LedStartAnchor;
  direction: LedDirection;
}
