/** Preview API bridge (v1.6) — thin `invoke()` wrappers over
 * `PREVIEW_COMMANDS`, wrapped in try/catch to degrade a transport
 * rejection to a synthetic coded failure rather than throwing. */

import {
  CONTROL_POPUP_STATUS,
  LED_TEST_STATUS,
  PREVIEW_COMMANDS,
  TWIN_OVERLAY_STATUS,
  type CloseLedTwinOverlayPayload,
  type ControlPopupResult,
  type LedPreviewStatus,
  type LedTestPatternResult,
  type OpenLedTwinOverlayPayload,
  type StartLedTestPatternPayload,
  type TwinOverlayResult,
} from "@/shared/contracts/preview";
import { parseCommandError } from "@/shared/contracts/status";
import { invokeCommand, type CommandInvoker } from "@/shared/ipcApi";

// ---------------------------------------------------------------------------
// Synthetic fallbacks — returned (never thrown) when the transport rejects.
// ---------------------------------------------------------------------------

function failedTestResult(error: unknown): LedTestPatternResult {
  return {
    active: false,
    previewOnly: false,
    status: {
      code: LED_TEST_STATUS.PATTERN_RUNTIME_ERROR,
      message: parseCommandError(error).message,
      details: null,
    },
  };
}

function idlePreviewStatus(): LedPreviewStatus {
  return {
    testActive: false,
    source: "idle",
    twinDisplays: [],
    popupVisible: false,
    liveTwinSupported: false,
  };
}

// ---------------------------------------------------------------------------
// Test patterns
// ---------------------------------------------------------------------------

/** Start a synthetic LED test pattern, overriding whatever lighting mode is currently active. */
export async function startLedTestPattern(
  payload: StartLedTestPatternPayload,
  invoker: CommandInvoker = invokeCommand,
): Promise<LedTestPatternResult> {
  try {
    return await invoker(PREVIEW_COMMANDS.START_TEST_PATTERN, { payload });
  } catch (error) {
    console.error("[LumaSync] start_led_test_pattern failed:", error);
    return failedTestResult(error);
  }
}

/** Stop the active LED test pattern and restore whatever mode it was superseding. */
export async function stopLedTestPattern(
  invoker: CommandInvoker = invokeCommand,
): Promise<LedTestPatternResult> {
  try {
    return await invoker(PREVIEW_COMMANDS.STOP_TEST_PATTERN);
  } catch (error) {
    console.error("[LumaSync] stop_led_test_pattern failed:", error);
    // A transport rejection means the test may still be running — reporting
    // PATTERN_STOPPED here would claim a stop that never happened.
    return failedTestResult(error);
  }
}

export async function getLedPreviewStatus(
  invoker: CommandInvoker = invokeCommand,
): Promise<LedPreviewStatus> {
  try {
    return await invoker(PREVIEW_COMMANDS.GET_PREVIEW_STATUS);
  } catch (error) {
    console.error("[LumaSync] get_led_preview_status failed:", error);
    return idlePreviewStatus();
  }
}

// ---------------------------------------------------------------------------
// Twin overlay window
// ---------------------------------------------------------------------------

/** Open the borderless digital-twin overlay window mirroring LED output on the given display. */
export async function openLedTwinOverlay(
  payload: OpenLedTwinOverlayPayload,
  invoker: CommandInvoker = invokeCommand,
): Promise<TwinOverlayResult> {
  try {
    return await invoker(PREVIEW_COMMANDS.OPEN_TWIN_OVERLAY, { payload });
  } catch (error) {
    console.error("[LumaSync] open_led_twin_overlay failed:", error);
    return {
      ok: false,
      code: TWIN_OVERLAY_STATUS.OPEN_FAILED,
      message: parseCommandError(error).message,
    };
  }
}

/// `payload` defaults to `{}` rather than `undefined`: Tauri drops an undefined
/// key during serialization, and the Rust arg is required, so the documented
/// "close every overlay" branch would fail with "invalid args" instead.
export async function closeLedTwinOverlay(
  payload: CloseLedTwinOverlayPayload = {},
  invoker: CommandInvoker = invokeCommand,
): Promise<TwinOverlayResult> {
  try {
    return await invoker(PREVIEW_COMMANDS.CLOSE_TWIN_OVERLAY, { payload });
  } catch (error) {
    console.error("[LumaSync] close_led_twin_overlay failed:", error);
    return {
      ok: false,
      code: TWIN_OVERLAY_STATUS.CLOSE_FAILED,
      message: parseCommandError(error).message,
    };
  }
}

// ---------------------------------------------------------------------------
// Control popup window
// ---------------------------------------------------------------------------

/** Create the LED control popup window if it doesn't exist yet, or bring it to front if it does. */
export async function openLedControlPopup(
  invoker: CommandInvoker = invokeCommand,
): Promise<ControlPopupResult> {
  try {
    return await invoker(PREVIEW_COMMANDS.OPEN_CONTROL_POPUP);
  } catch (error) {
    console.error("[LumaSync] open_led_control_popup failed:", error);
    return { ok: false, code: CONTROL_POPUP_STATUS.FAILED, message: parseCommandError(error).message, visible: false };
  }
}

/** Unminimize, show, and focus the LED control popup. Fails if it hasn't been created via `openLedControlPopup` yet. */
export async function showLedControlPopup(
  invoker: CommandInvoker = invokeCommand,
): Promise<ControlPopupResult> {
  try {
    return await invoker(PREVIEW_COMMANDS.SHOW_CONTROL_POPUP);
  } catch (error) {
    console.error("[LumaSync] show_led_control_popup failed:", error);
    return { ok: false, code: CONTROL_POPUP_STATUS.FAILED, message: parseCommandError(error).message, visible: false };
  }
}

/** Hide the LED control popup window without destroying it — `showLedControlPopup` can bring it back. */
export async function hideLedControlPopup(
  invoker: CommandInvoker = invokeCommand,
): Promise<ControlPopupResult> {
  try {
    return await invoker(PREVIEW_COMMANDS.HIDE_CONTROL_POPUP);
  } catch (error) {
    console.error("[LumaSync] hide_led_control_popup failed:", error);
    return { ok: false, code: CONTROL_POPUP_STATUS.FAILED, message: parseCommandError(error).message, visible: false };
  }
}
