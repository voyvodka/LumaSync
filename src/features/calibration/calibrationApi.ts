import { invoke } from "@tauri-apps/api/core";

import { DEVICE_COMMANDS } from "../../shared/contracts/device";

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
