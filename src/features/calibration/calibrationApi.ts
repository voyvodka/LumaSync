import { invokeCommand } from "@/shared/ipcApi";

import {
  DISPLAY_OVERLAY_COMMANDS,
  type DisplayId,
  type DisplayInfo,
  type DisplayOverlayCommandResult,
  type OverlayPreviewPayload,
} from "@/shared/contracts/display";

export async function listDisplays(): Promise<DisplayInfo[]> {
  return invokeCommand(DISPLAY_OVERLAY_COMMANDS.LIST_DISPLAYS);
}

/** Open the fullscreen calibration overlay window on the given display. */
export async function openDisplayOverlay(
  displayId: DisplayId,
  preview?: OverlayPreviewPayload,
): Promise<DisplayOverlayCommandResult> {
  return invokeCommand(DISPLAY_OVERLAY_COMMANDS.OPEN_DISPLAY_OVERLAY, {
    displayId,
    preview,
  });
}

export async function closeDisplayOverlay(displayId: DisplayId): Promise<DisplayOverlayCommandResult> {
  return invokeCommand(DISPLAY_OVERLAY_COMMANDS.CLOSE_DISPLAY_OVERLAY, { displayId });
}

/** Push updated preview content (colors/regions) to the currently open calibration overlay. */
export async function updateDisplayOverlayPreview(
  preview: OverlayPreviewPayload,
): Promise<DisplayOverlayCommandResult> {
  return invokeCommand(DISPLAY_OVERLAY_COMMANDS.UPDATE_DISPLAY_OVERLAY_PREVIEW, {
    preview,
  });
}
