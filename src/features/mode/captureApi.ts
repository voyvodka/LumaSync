import { invoke } from "@tauri-apps/api/core";

import {
  CAPTURE_COMMANDS,
  SCREEN_CAPTURE_PERMISSION_STATUS,
  SCREEN_CAPTURE_SETTINGS_STATUS,
  type ScreenCapturePermissionResult,
  type ScreenCaptureSettingsResult,
} from "@/shared/contracts/capture";

/** Non-prompting probe. Advisory only — never gate a start on it, or a
 *  first-run user never sees the OS prompt the start path raises. */
export async function getScreenCapturePermission(): Promise<ScreenCapturePermissionResult> {
  try {
    return await invoke<ScreenCapturePermissionResult>(
      CAPTURE_COMMANDS.GET_SCREEN_CAPTURE_PERMISSION,
    );
  } catch (error) {
    // An unreachable probe must not block a start that might well succeed.
    console.error("[LumaSync] screen capture permission probe failed:", error);
    return { code: SCREEN_CAPTURE_PERMISSION_STATUS.NOT_REQUIRED };
  }
}

export async function openScreenCaptureSettings(): Promise<ScreenCaptureSettingsResult> {
  try {
    return await invoke<ScreenCaptureSettingsResult>(
      CAPTURE_COMMANDS.OPEN_SCREEN_CAPTURE_SETTINGS,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[LumaSync] opening screen recording settings failed:", message);
    return { code: SCREEN_CAPTURE_SETTINGS_STATUS.OPEN_FAILED, message };
  }
}
