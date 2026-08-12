import type { LedCalibrationConfig } from "./contracts";
import { sumSegmentCounts } from "./contracts";

export type CalibrationValidationCode =
  | "COUNTS_REQUIRED"
  | "SEGMENT_NEGATIVE"
  | "TOTAL_MISMATCH"
  | "BOTTOM_MISSING_NEGATIVE"
  | "BOTTOM_MISSING_EXCEEDS_BOTTOM"
  | "NO_LEDS_CONFIGURED";

export interface CalibrationValidationError {
  code: CalibrationValidationCode;
  field: string;
}

export interface CalibrationValidationResult {
  ok: boolean;
  errors: CalibrationValidationError[];
}

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
