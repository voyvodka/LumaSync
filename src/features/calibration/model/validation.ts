import type { LedCalibrationConfig } from "./contracts";

export type CalibrationValidationCode =
  | "COUNTS_REQUIRED"
  | "SEGMENT_NON_POSITIVE"
  | "TOTAL_MISMATCH"
  | "BOTTOM_GAP_NEGATIVE";

export interface CalibrationValidationError {
  code: CalibrationValidationCode;
  field: string;
}

export interface CalibrationValidationResult {
  ok: boolean;
  errors: CalibrationValidationError[];
}

export function validateCalibrationConfig(_config: LedCalibrationConfig): CalibrationValidationResult {
  return {
    ok: true,
    errors: [],
  };
}
