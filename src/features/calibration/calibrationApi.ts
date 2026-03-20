import { invoke } from "@tauri-apps/api/core";

import { DEVICE_COMMANDS } from "../../shared/contracts/device";
import {
  DISPLAY_OVERLAY_COMMANDS,
  type DisplayId,
  type DisplayInfo,
  type DisplayOverlayCommandResult,
} from "../../shared/contracts/display";

export interface CalibrationTestPatternStartPayload {
  ledIndexes: number[];
  frameMs: number;
  brightness: number;
}

export interface CalibrationTestPatternResult {
  active: boolean;
  previewOnly: boolean;
  status: {
    code: string;
    message: string;
    details?: string;
  };
}

export async function startCalibrationTestPattern(
  payload: CalibrationTestPatternStartPayload,
): Promise<CalibrationTestPatternResult> {
  return invoke<CalibrationTestPatternResult>(DEVICE_COMMANDS.START_CALIBRATION_TEST_PATTERN, { payload });
}

export async function stopCalibrationTestPattern(): Promise<CalibrationTestPatternResult> {
  return invoke<CalibrationTestPatternResult>(DEVICE_COMMANDS.STOP_CALIBRATION_TEST_PATTERN);
}

export async function listDisplays(): Promise<DisplayInfo[]> {
  return invoke<DisplayInfo[]>(DISPLAY_OVERLAY_COMMANDS.LIST_DISPLAYS);
}

export async function openDisplayOverlay(displayId: DisplayId): Promise<DisplayOverlayCommandResult> {
  return invoke<DisplayOverlayCommandResult>(DISPLAY_OVERLAY_COMMANDS.OPEN_DISPLAY_OVERLAY, { displayId });
}

export async function closeDisplayOverlay(displayId: DisplayId): Promise<DisplayOverlayCommandResult> {
  return invoke<DisplayOverlayCommandResult>(DISPLAY_OVERLAY_COMMANDS.CLOSE_DISPLAY_OVERLAY, { displayId });
}
