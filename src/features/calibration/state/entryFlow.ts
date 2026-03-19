import type { LedCalibrationConfig } from "../model/contracts";

export type CalibrationOverlayStep = "template" | "editor";

export interface CalibrationOverlayEntry {
  open: boolean;
  step: CalibrationOverlayStep;
  reason: "first-connection" | "settings-edit" | "none";
  initialConfig?: LedCalibrationConfig;
}

interface DeriveCalibrationOverlayEntryInput {
  hasConnectedDevice: boolean;
  savedCalibration?: LedCalibrationConfig;
}

export function deriveCalibrationOverlayEntry(
  input: DeriveCalibrationOverlayEntryInput,
): CalibrationOverlayEntry {
  if (input.hasConnectedDevice && !input.savedCalibration) {
    return {
      open: true,
      step: "template",
      reason: "first-connection",
    };
  }

  return {
    open: false,
    step: "editor",
    reason: "none",
    initialConfig: input.savedCalibration,
  };
}

export function startCalibrationFromSettings(
  savedCalibration?: LedCalibrationConfig,
): CalibrationOverlayEntry {
  return {
    open: true,
    step: "editor",
    reason: "settings-edit",
    initialConfig: savedCalibration,
  };
}
