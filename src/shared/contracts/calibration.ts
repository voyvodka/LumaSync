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

/** Winding direction of the LED strip around the display perimeter. */
export type LedDirection = "cw" | "ccw";

/** Which adjacent segment "owns" the shared corner LED. */
export type CornerOwnership = "horizontal" | "vertical";

export type LedVisualPreset = "subtle" | "vivid";

export type LedSegmentKey = "top" | "right" | "bottom" | "left";

/** Where the LED strip's first pixel sits, including the two bottom-gap variants for split runs. */
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
  templateId?: string | null;
  counts: LedSegmentCounts;
  bottomMissing: number;
  cornerOwnership: CornerOwnership;
  visualPreset: LedVisualPreset;
  startAnchor: LedStartAnchor;
  direction: LedDirection;
  totalLeds: number;
}

/** A named preset of calibration values, offered as a starting point in the editor. */
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

// The `CALIBRATION_PATTERN_*` status surface was removed once LED Setup moved
// onto `start_led_test_pattern` (`contracts/preview.ts`). Do not add a second
// test-pattern path — having one is what let the old no-op survive unnoticed.
