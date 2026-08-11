/**
 * Preview API bridge (v1.6 LED Preview & Test Experience).
 *
 * Thin `invoke()` wrappers over the `PREVIEW_COMMANDS` ids. Commands are
 * invoked by STRING id from the contract — there is no compile-time coupling
 * to the Rust half (it lands in parallel), so the frontend can ship and
 * typecheck independently.
 *
 * Coded-status discipline (`feedback_rust_backend_errors.md`): the Rust
 * commands NEVER throw a domain error — they resolve with a coded status on
 * their ok-result. The `Result::Err` arm is reserved for lock-poison /
 * serialize failures only. We still wrap every call in try/catch so a
 * transport-level rejection is logged with the `[LumaSync]` prefix (the
 * silent-catch ban is absolute) and degraded to a synthetic coded failure the
 * UI can render uniformly — never a thrown exception that could white-screen a
 * preview surface.
 */

import { invoke } from "@tauri-apps/api/core";

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
} from "../../shared/contracts/preview";

export type PreviewInvoker = <T>(
  command: string,
  payload?: Record<string, unknown>,
) => Promise<T>;

const defaultInvoke: PreviewInvoker = (command, payload) => invoke(command, payload);

// ---------------------------------------------------------------------------
// Synthetic fallbacks — returned (never thrown) when the transport rejects.
// ---------------------------------------------------------------------------

function transportMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Preview command transport failure";
}

function failedTestResult(error: unknown): LedTestPatternResult {
  return {
    active: false,
    previewOnly: false,
    status: {
      code: LED_TEST_STATUS.PATTERN_RUNTIME_ERROR,
      message: transportMessage(error),
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

export async function startLedTestPattern(
  payload: StartLedTestPatternPayload,
  invoker: PreviewInvoker = defaultInvoke,
): Promise<LedTestPatternResult> {
  try {
    return await invoker<LedTestPatternResult>(PREVIEW_COMMANDS.START_TEST_PATTERN, { payload });
  } catch (error) {
    console.error("[LumaSync] start_led_test_pattern failed:", error);
    return failedTestResult(error);
  }
}

export async function stopLedTestPattern(
  invoker: PreviewInvoker = defaultInvoke,
): Promise<LedTestPatternResult> {
  try {
    return await invoker<LedTestPatternResult>(PREVIEW_COMMANDS.STOP_TEST_PATTERN);
  } catch (error) {
    console.error("[LumaSync] stop_led_test_pattern failed:", error);
    // A transport rejection means the test may still be running — reporting
    // PATTERN_STOPPED here would claim a stop that never happened.
    return failedTestResult(error);
  }
}

export async function getLedPreviewStatus(
  invoker: PreviewInvoker = defaultInvoke,
): Promise<LedPreviewStatus> {
  try {
    return await invoker<LedPreviewStatus>(PREVIEW_COMMANDS.GET_PREVIEW_STATUS);
  } catch (error) {
    console.error("[LumaSync] get_led_preview_status failed:", error);
    return idlePreviewStatus();
  }
}

// ---------------------------------------------------------------------------
// Twin overlay window
// ---------------------------------------------------------------------------

export async function openLedTwinOverlay(
  payload: OpenLedTwinOverlayPayload,
  invoker: PreviewInvoker = defaultInvoke,
): Promise<TwinOverlayResult> {
  try {
    return await invoker<TwinOverlayResult>(PREVIEW_COMMANDS.OPEN_TWIN_OVERLAY, { payload });
  } catch (error) {
    console.error("[LumaSync] open_led_twin_overlay failed:", error);
    return {
      ok: false,
      code: TWIN_OVERLAY_STATUS.OPEN_FAILED,
      message: transportMessage(error),
    };
  }
}

/// `payload` defaults to `{}` rather than `undefined`: Tauri drops an undefined
/// key during serialization, and the Rust arg is required, so the documented
/// "close every overlay" branch would fail with "invalid args" instead.
export async function closeLedTwinOverlay(
  payload: CloseLedTwinOverlayPayload = {},
  invoker: PreviewInvoker = defaultInvoke,
): Promise<TwinOverlayResult> {
  try {
    return await invoker<TwinOverlayResult>(PREVIEW_COMMANDS.CLOSE_TWIN_OVERLAY, { payload });
  } catch (error) {
    console.error("[LumaSync] close_led_twin_overlay failed:", error);
    return {
      ok: false,
      code: TWIN_OVERLAY_STATUS.CLOSE_FAILED,
      message: transportMessage(error),
    };
  }
}

// ---------------------------------------------------------------------------
// Control popup window
// ---------------------------------------------------------------------------

export async function openLedControlPopup(
  invoker: PreviewInvoker = defaultInvoke,
): Promise<ControlPopupResult> {
  try {
    return await invoker<ControlPopupResult>(PREVIEW_COMMANDS.OPEN_CONTROL_POPUP);
  } catch (error) {
    console.error("[LumaSync] open_led_control_popup failed:", error);
    return { ok: false, code: CONTROL_POPUP_STATUS.FAILED, message: transportMessage(error), visible: false };
  }
}

export async function showLedControlPopup(
  invoker: PreviewInvoker = defaultInvoke,
): Promise<ControlPopupResult> {
  try {
    return await invoker<ControlPopupResult>(PREVIEW_COMMANDS.SHOW_CONTROL_POPUP);
  } catch (error) {
    console.error("[LumaSync] show_led_control_popup failed:", error);
    return { ok: false, code: CONTROL_POPUP_STATUS.FAILED, message: transportMessage(error), visible: false };
  }
}

export async function hideLedControlPopup(
  invoker: PreviewInvoker = defaultInvoke,
): Promise<ControlPopupResult> {
  try {
    return await invoker<ControlPopupResult>(PREVIEW_COMMANDS.HIDE_CONTROL_POPUP);
  } catch (error) {
    console.error("[LumaSync] hide_led_control_popup failed:", error);
    return { ok: false, code: CONTROL_POPUP_STATUS.FAILED, message: transportMessage(error), visible: false };
  }
}

/**
 * Convenience: open the full preview surface (twin overlay for the given
 * display + the interactive control popup) in one call. Used by the LED Setup
 * launch button and the tray `tray:show-led-preview` event handler.
 */
export async function openLedPreviewSurface(
  options: { scope: OpenLedTwinOverlayPayload["scope"]; displayId?: string; twinEnabled?: boolean },
  invoker: PreviewInvoker = defaultInvoke,
): Promise<void> {
  const tasks: Promise<unknown>[] = [];
  if (options.twinEnabled !== false) {
    tasks.push(
      openLedTwinOverlay({ scope: options.scope, displayId: options.displayId }, invoker),
    );
  }
  // Open (idempotent) then reveal the control popup.
  tasks.push(
    openLedControlPopup(invoker).then(() => showLedControlPopup(invoker)),
  );
  await Promise.allSettled(tasks);
}
