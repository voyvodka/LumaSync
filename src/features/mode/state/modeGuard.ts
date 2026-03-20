import type { LedCalibrationConfig } from "../../calibration/model/contracts";

export const MODE_GUARD_REASONS = {
  CALIBRATION_REQUIRED: "CALIBRATION_REQUIRED",
} as const;

export type ModeGuardReason = (typeof MODE_GUARD_REASONS)[keyof typeof MODE_GUARD_REASONS];

export interface LedModeGuardResult {
  canEnable: boolean;
  reason: ModeGuardReason | null;
}

export function canEnableLedMode(calibration?: LedCalibrationConfig): LedModeGuardResult {
  if (!calibration) {
    return {
      canEnable: false,
      reason: MODE_GUARD_REASONS.CALIBRATION_REQUIRED,
    };
  }

  return {
    canEnable: true,
    reason: null,
  };
}
