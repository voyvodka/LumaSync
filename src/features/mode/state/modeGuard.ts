import type { LedCalibrationConfig } from "@/features/calibration/model/contracts";
import type { HueRuntimeTarget } from "@/shared/contracts/hue";

/** Machine-readable reasons LED mode may be blocked from enabling. */
export const MODE_GUARD_REASONS = {
  CALIBRATION_REQUIRED: "CALIBRATION_REQUIRED",
} as const;

/** Union of the reasons in {@link MODE_GUARD_REASONS}. */
export type ModeGuardReason = (typeof MODE_GUARD_REASONS)[keyof typeof MODE_GUARD_REASONS];

/** Whether LED mode can currently be enabled, and why not if it can't. */
export interface LedModeGuardResult {
  canEnable: boolean;
  reason: ModeGuardReason | null;
}

/** Current state consulted when the user attempts to enable LED mode. */
export interface LedModeEnableAttemptInput {
  currentEnabled: boolean;
  calibration?: LedCalibrationConfig;
  selectedTargets?: HueRuntimeTarget[];
}

/** Result of an LED-mode enable attempt: the resolved enabled state and any follow-up UI action. */
export interface LedModeEnableAttempt {
  nextEnabled: boolean;
  reason: ModeGuardReason | null;
  shouldOpenCalibration: boolean;
}

/** Gate for LED mode: USB targets require a saved calibration; Hue-only targets do not. */
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

/** Resolves an enable attempt against the calibration gate, signaling whether to open calibration instead. */
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
