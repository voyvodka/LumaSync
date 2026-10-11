/** Preview API bridge — thin `invoke()` wrappers over `PREVIEW_COMMANDS`,
 * wrapped in try/catch to degrade a transport rejection to a synthetic coded
 * failure rather than throwing. */

import { Channel } from "@tauri-apps/api/core";

import {
  LED_TEST_STATUS,
  PREVIEW_COMMANDS,
  PREVIEW_STATUS,
  type LedTestPatternResult,
  type PreviewSession,
  type PreviewSessionResult,
  type PreviewSessionStatusCode,
  type SceneKind,
  type StartLedTestPatternPayload,
  type TwinSubscribeResult,
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

/** A rejected session command says nothing about the session, so it reads closed with the failure's code. */
function failedSessionResult(code: PreviewSessionStatusCode, error: unknown): PreviewSessionResult {
  const parsed = parseCommandError(error);
  return {
    session: { state: "closed" },
    status: { code, message: parsed.message, details: parsed.code ?? null },
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

// ---------------------------------------------------------------------------
// Preview session
// ---------------------------------------------------------------------------

/** Open the preview: popup and twin, main window out of the way. Changes no light. */
export async function openPreview(invoker: CommandInvoker = invokeCommand): Promise<PreviewSessionResult> {
  try {
    return await invoker(PREVIEW_COMMANDS.OPEN_PREVIEW);
  } catch (error) {
    console.error("[LumaSync] open_preview failed:", error);
    return failedSessionResult(PREVIEW_STATUS.OPEN_FAILED, error);
  }
}

export async function closePreview(invoker: CommandInvoker = invokeCommand): Promise<PreviewSessionResult> {
  try {
    return await invoker(PREVIEW_COMMANDS.CLOSE_PREVIEW);
  } catch (error) {
    console.error("[LumaSync] close_preview failed:", error);
    return failedSessionResult(PREVIEW_STATUS.CLOSE_FAILED, error);
  }
}

export async function setPreviewPopupHidden(
  hidden: boolean,
  invoker: CommandInvoker = invokeCommand,
): Promise<PreviewSessionResult> {
  try {
    return await invoker(PREVIEW_COMMANDS.SET_POPUP_HIDDEN, { payload: { hidden } });
  } catch (error) {
    console.error("[LumaSync] set_preview_popup_hidden failed:", error);
    return failedSessionResult(PREVIEW_STATUS.NOT_OPEN, error);
  }
}

/** The session as Rust holds it. A rejected read says nothing about it, so it
 * answers `null` rather than inventing a closed session. */
export async function getPreviewSession(invoker: CommandInvoker = invokeCommand): Promise<PreviewSession | null> {
  try {
    return await invoker(PREVIEW_COMMANDS.GET_SESSION);
  } catch (error) {
    console.error("[LumaSync] get_preview_session failed:", error);
    return null;
  }
}

export async function setPreviewTwinHidden(
  hidden: boolean,
  invoker: CommandInvoker = invokeCommand,
): Promise<PreviewSessionResult> {
  try {
    return await invoker(PREVIEW_COMMANDS.SET_TWIN_HIDDEN, { payload: { hidden } });
  } catch (error) {
    console.error("[LumaSync] set_preview_twin_hidden failed:", error);
    return failedSessionResult(PREVIEW_STATUS.NOT_OPEN, error);
  }
}

// ---------------------------------------------------------------------------
// Scenes
// ---------------------------------------------------------------------------

/** Play `kind`; a playing scene switches in place. */
export async function startPreviewScene(
  kind: SceneKind,
  invoker: CommandInvoker = invokeCommand,
): Promise<PreviewSessionResult> {
  try {
    return await invoker(PREVIEW_COMMANDS.START_SCENE, { payload: { kind } });
  } catch (error) {
    console.error("[LumaSync] start_preview_scene failed:", error);
    return failedSessionResult(PREVIEW_STATUS.SCENE_START_FAILED, error);
  }
}

/** Stop the scene; the mode it interrupted comes back. */
export async function stopPreviewScene(invoker: CommandInvoker = invokeCommand): Promise<PreviewSessionResult> {
  try {
    return await invoker(PREVIEW_COMMANDS.STOP_SCENE);
  } catch (error) {
    console.error("[LumaSync] stop_preview_scene failed:", error);
    // The scene may still be playing: RESTORE_FAILED says the lights are not
    // back, and claims no stop.
    return failedSessionResult(PREVIEW_STATUS.RESTORE_FAILED, error);
  }
}

export async function setPreviewSceneBrightness(
  brightness: number,
  invoker: CommandInvoker = invokeCommand,
): Promise<PreviewSessionResult> {
  try {
    return await invoker(PREVIEW_COMMANDS.SET_SCENE_BRIGHTNESS, { payload: { brightness } });
  } catch (error) {
    console.error("[LumaSync] set_preview_scene_brightness failed:", error);
    return failedSessionResult(PREVIEW_STATUS.SCENE_NOT_RUNNING, error);
  }
}

/** The twin's frames, each handed to `onFrame` as the raw buffer. */
export async function subscribeTwinFrames(
  onFrame: (frame: ArrayBuffer) => void,
  invoker: CommandInvoker = invokeCommand,
): Promise<TwinSubscribeResult> {
  const channel = new Channel<ArrayBuffer>();
  channel.onmessage = onFrame;
  try {
    return await invoker(PREVIEW_COMMANDS.SUBSCRIBE_TWIN_FRAMES, { onFrame: channel });
  } catch (error) {
    console.error("[LumaSync] subscribe_twin_frames failed:", error);
    const parsed = parseCommandError(error);
    return {
      layout: null,
      status: { code: PREVIEW_STATUS.NOT_OPEN, message: parsed.message, details: parsed.code ?? null },
    };
  }
}
