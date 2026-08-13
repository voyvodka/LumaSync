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

import type { CommandStatusOf } from "./status";

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

// ---------------------------------------------------------------------------
// Calibration test-pattern command status
// ---------------------------------------------------------------------------

/** Exactly what `calibration.rs` puts on a `start`/`stop_calibration_test_pattern` status. */
export const CALIBRATION_TEST_PATTERN_STATUS = {
  PATTERN_STARTED: "CALIBRATION_PATTERN_STARTED",
  /** No device connected — the editor still animates, nothing reaches a strip. */
  PREVIEW_ONLY: "CALIBRATION_PREVIEW_ONLY",
  PATTERN_STOPPED: "CALIBRATION_PATTERN_STOPPED",
} as const;

export type CalibrationTestPatternStatusCode =
  (typeof CALIBRATION_TEST_PATTERN_STATUS)[keyof typeof CALIBRATION_TEST_PATTERN_STATUS];

export type CalibrationTestPatternStatus = CommandStatusOf<CalibrationTestPatternStatusCode>;

/** Thrown as `Err(String)` formatted `"CODE: detail"`. A `catch` sees these; a
 * `switch (status.code)` never will. */
export const CALIBRATION_COMMAND_ERRORS = {
  PATTERN_INVALID: "CALIBRATION_PATTERN_INVALID",
  STATE_READ_FAILED: "CALIBRATION_STATE_READ_FAILED",
} as const;

export type CalibrationCommandErrorCode =
  (typeof CALIBRATION_COMMAND_ERRORS)[keyof typeof CALIBRATION_COMMAND_ERRORS];
