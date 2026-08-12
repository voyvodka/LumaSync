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

interface AutoOpenOnConnectionInput {
  connected: boolean;
  wasConnected: boolean;
  hasCalibration: boolean;
  alreadyAutoOpened: boolean;
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

export function shouldAutoOpenCalibrationOnConnection(
  input: AutoOpenOnConnectionInput,
): boolean {
  if (input.alreadyAutoOpened || input.hasCalibration) {
    return false;
  }

  return input.connected && !input.wasConnected;
}
