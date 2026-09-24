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
  connected: boolean;
  wasConnected: boolean;
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
 * A strip just connected and no LED layout is saved: the moment to point at
 * LED Setup. A prompt, never a navigation — the user stays on the page they
 * connected from.
 */
export function shouldPromptLedSetupOnConnection(
  input: PromptOnConnectionInput,
): boolean {
  if (input.alreadyPrompted || input.hasCalibration) {
    return false;
  }

  return input.connected && !input.wasConnected;
}
