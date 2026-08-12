import type { LedCalibrationConfig } from "../model/contracts";

/** Decision of whether/why to open the calibration overlay, and what config to seed it with. */
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

/** Decides whether a newly connected device should force-open first-time calibration. */
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

/** Opens the calibration overlay for a user-initiated edit from Settings. */
export function startCalibrationFromSettings(
  savedCalibration?: LedCalibrationConfig,
): CalibrationOverlayEntry {
  return {
    open: true,
    reason: "settings-edit",
    initialConfig: savedCalibration,
  };
}

/** Whether a fresh device connection should auto-open calibration (only once, only if none is saved yet). */
export function shouldAutoOpenCalibrationOnConnection(
  input: AutoOpenOnConnectionInput,
): boolean {
  if (input.alreadyAutoOpened || input.hasCalibration) {
    return false;
  }

  return input.connected && !input.wasConnected;
}
