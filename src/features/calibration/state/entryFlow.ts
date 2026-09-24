import type { LedCalibrationConfig } from "../model/contracts";

export interface CalibrationOverlayEntry {
  open: boolean;
  reason: "first-connection" | "settings-edit" | "none";
  initialConfig?: LedCalibrationConfig;
}

interface DeriveCalibrationOverlayEntryInput {
  hasConnectedDevice: boolean;
  savedCalibration?: LedCalibrationConfig;
}

interface PromptOnConnectionInput {
  /** The user pressed Connect; a boot auto-reconnect or a recovery is not a first connect. */
  userInitiated: boolean;
  hasCalibration: boolean;
  alreadyPrompted: boolean;
}

export function deriveCalibrationOverlayEntry(
  input: DeriveCalibrationOverlayEntryInput,
): CalibrationOverlayEntry {
  if (input.hasConnectedDevice && !input.savedCalibration) {
    return {
      open: true,
      reason: "first-connection",
    };
  }

  return {
    open: false,
    reason: "none",
    initialConfig: input.savedCalibration,
  };
}

export function startCalibrationFromSettings(
  savedCalibration?: LedCalibrationConfig,
): CalibrationOverlayEntry {
  return {
    open: true,
    reason: "settings-edit",
    initialConfig: savedCalibration,
  };
}

/**
 * The user just connected a strip and no LED layout is saved: the moment to
 * point at LED Setup. A prompt, never a navigation — the user stays on the
 * page they connected from. A connect the app made on its own (the boot
 * auto-reconnect, recovery) never prompts, or a user who has not drawn a
 * layout would be nudged on every launch.
 */
export function shouldPromptLedSetupOnConnection(
  input: PromptOnConnectionInput,
): boolean {
  if (input.alreadyPrompted || input.hasCalibration) {
    return false;
  }

  return input.userInitiated;
}
