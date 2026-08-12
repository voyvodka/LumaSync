import type { LedCalibrationConfig } from "./contracts";
import { sumSegmentCounts } from "./contracts";

/** Machine-readable reasons a calibration config fails validation. */
export type CalibrationValidationCode =
  | "COUNTS_REQUIRED"
  | "SEGMENT_NEGATIVE"
  | "TOTAL_MISMATCH"
  | "BOTTOM_MISSING_NEGATIVE"
  | "BOTTOM_MISSING_EXCEEDS_BOTTOM"
  | "NO_LEDS_CONFIGURED";

/** A single validation failure, naming the offending field. */
export interface CalibrationValidationError {
  code: CalibrationValidationCode;
  field: string;
}

/** Outcome of validating a calibration config, with all accumulated errors (not just the first). */
export interface CalibrationValidationResult {
  ok: boolean;
  errors: CalibrationValidationError[];
}

/** Checks a calibration config's segment counts, stand-gap, and total for consistency before save. */
export function validateCalibrationConfig(_config: LedCalibrationConfig): CalibrationValidationResult {
  const errors: CalibrationValidationError[] = [];

  const counts = _config.counts;
  if (!counts) {
    errors.push({ code: "COUNTS_REQUIRED", field: "counts" });
    return { ok: false, errors };
  }

  const entries = Object.entries(counts) as Array<[string, number]>;
  for (const [segment, value] of entries) {
    if (!Number.isInteger(value) || value < 0) {
      errors.push({ code: "SEGMENT_NEGATIVE", field: `counts.${segment}` });
    }
  }

  if (!Number.isInteger(_config.bottomMissing) || _config.bottomMissing < 0) {
    errors.push({ code: "BOTTOM_MISSING_NEGATIVE", field: "bottomMissing" });
  } else if (_config.bottomMissing > counts.bottom) {
    errors.push({ code: "BOTTOM_MISSING_EXCEEDS_BOTTOM", field: "bottomMissing" });
  }

  const expectedTotal = sumSegmentCounts(counts);
  if (_config.totalLeds !== expectedTotal) {
    errors.push({ code: "TOTAL_MISMATCH", field: "totalLeds" });
  }

  if (expectedTotal === 0) {
    errors.push({ code: "NO_LEDS_CONFIGURED", field: "counts" });
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}
