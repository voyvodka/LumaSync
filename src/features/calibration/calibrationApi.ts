import { invoke } from "@tauri-apps/api/core";

import type { CalibrationTestPatternStatus } from "@/shared/contracts/calibration";
import { DEVICE_COMMANDS } from "@/shared/contracts/device";
import {
  DISPLAY_OVERLAY_COMMANDS,
  type DisplayId,
  type DisplayInfo,
  type DisplayOverlayCommandResult,
  type OverlayPreviewPayload,
} from "@/shared/contracts/display";

/** Which LEDs to light, how long each frame holds, and at what brightness for a calibration test pattern. */
export interface CalibrationTestPatternStartPayload {
  ledIndexes: number[];
  frameMs: number;
  brightness: number;
}

/** Result of a calibration test-pattern start/stop; `previewOnly` is true whenever no device is connected. */
export interface CalibrationTestPatternResult {
  active: boolean;
  previewOnly: boolean;
  status: CalibrationTestPatternStatus;
}

/**
 * Start a calibration test pattern on the given LED indexes. Runs preview-only
 * (no physical output) when no device is connected — check `previewOnly`.
 */
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

/** Open the fullscreen calibration overlay window on the given display. */
export async function openDisplayOverlay(
  displayId: DisplayId,
  preview?: OverlayPreviewPayload,
): Promise<DisplayOverlayCommandResult> {
  return invoke<DisplayOverlayCommandResult>(DISPLAY_OVERLAY_COMMANDS.OPEN_DISPLAY_OVERLAY, {
    displayId,
    preview,
  });
}

export async function closeDisplayOverlay(displayId: DisplayId): Promise<DisplayOverlayCommandResult> {
  return invoke<DisplayOverlayCommandResult>(DISPLAY_OVERLAY_COMMANDS.CLOSE_DISPLAY_OVERLAY, { displayId });
}

/** Push updated preview content (colors/regions) to the currently open calibration overlay. */
export async function updateDisplayOverlayPreview(
  preview: OverlayPreviewPayload,
): Promise<DisplayOverlayCommandResult> {
  return invoke<DisplayOverlayCommandResult>(DISPLAY_OVERLAY_COMMANDS.UPDATE_DISPLAY_OVERLAY_PREVIEW, {
    preview,
  });
}
