import type { LedCalibrationConfig } from "@/features/calibration/model/contracts";
import { LED_CALIBRATION_MAX_TOTAL_LEDS } from "@/shared/contracts/calibration";
import type { HueRuntimeTarget } from "@/shared/contracts/hue";

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
  // If targets are exclusively Hue (no USB), skip calibration requirement.
  // USB target (or no targets = default to USB) requires calibration.
  const usesUsb =
    !selectedTargets ||
    selectedTargets.length === 0 ||
    selectedTargets.includes("usb");

  // Rust refuses a layout past the cap, so offering the mode would only fail.
  const usable = calibration !== undefined && calibration.totalLeds <= LED_CALIBRATION_MAX_TOTAL_LEDS;
  if (usesUsb && !usable) {
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
