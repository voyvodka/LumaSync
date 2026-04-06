import type { LedCalibrationConfig } from "../../calibration/model/contracts";
import type { HueRuntimeTarget } from "../../../shared/contracts/hue";

export const MODE_GUARD_REASONS = {
  CALIBRATION_REQUIRED: "CALIBRATION_REQUIRED",
} as const;

export type ModeGuardReason = (typeof MODE_GUARD_REASONS)[keyof typeof MODE_GUARD_REASONS];

export interface LedModeGuardResult {
  canEnable: boolean;
  reason: ModeGuardReason | null;
}

export interface LedModeEnableAttemptInput {
  currentEnabled: boolean;
  calibration?: LedCalibrationConfig;
  selectedTargets?: HueRuntimeTarget[];
}

export interface LedModeEnableAttempt {
  nextEnabled: boolean;
  reason: ModeGuardReason | null;
  shouldOpenCalibration: boolean;
}

export function canEnableLedMode(
  calibration?: LedCalibrationConfig,
  selectedTargets?: HueRuntimeTarget[],
): LedModeGuardResult {
  // D-05: If targets are exclusively Hue (no USB), skip calibration requirement.
  // USB target (or no targets = default to USB) requires calibration.
  const usesUsb =
    !selectedTargets ||
    selectedTargets.length === 0 ||
    selectedTargets.includes("usb");

  if (usesUsb && !calibration) {
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

export function resolveLedModeEnableAttempt(
  input: LedModeEnableAttemptInput,
): LedModeEnableAttempt {
  const gate = canEnableLedMode(input.calibration, input.selectedTargets);

  if (!gate.canEnable) {
    return {
      nextEnabled: input.currentEnabled,
      reason: gate.reason,
      shouldOpenCalibration: true,
    };
  }

  return {
    nextEnabled: true,
    reason: null,
    shouldOpenCalibration: false,
  };
}
