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

/**
 * `localOutputBound`: a strip or WLED panel is connected. Every fresh install
 * has `usb` selected, so selection alone would lock a Hue-only user out of
 * every mode behind a layout for a strip they do not own; Rust asks for a
 * layout only when one is there too.
 */
export function canEnableLedMode(
  calibration?: LedCalibrationConfig,
  selectedTargets?: HueRuntimeTarget[],
  localOutputBound = true,
): LedModeGuardResult {
  // USB target (or no targets = default to USB) requires calibration.
  const usesUsb =
    localOutputBound &&
    (!selectedTargets || selectedTargets.length === 0 || selectedTargets.includes("usb"));

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
