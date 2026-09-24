/**
 * Commands whose *effect* cannot exist in a browser tab, answered anyway.
 *
 * These address a second webview window or an OS surface — a tray menu, a
 * notification, a Finder window. None of that is reachable here, and that part
 * is a real limit rather than a gap to close.
 *
 * What was a gap: `INTENTIONALLY_UNMAPPED` claimed these were "answered, the
 * calling state machine advances and the buttons are exercisable". They were
 * not. The list feeds the compile-time coverage guard and nothing else, so
 * `handlerFor` returned `undefined` and `boot.ts` threw — which meant
 * `update_tray_labels` blew up during bootstrap on **every** browser launch,
 * and the eleven surfaces the comment described as exercisable all failed on
 * the first click.
 *
 * So they are answered here, honestly: a success-shaped result of the type the
 * caller declares, so the state machine really does advance. Nothing appears,
 * which is the documented and unavoidable half.
 *
 * `get_led_preview_status` is the exception and no longer belongs in that
 * group at all — `mock/events.ts` owns the preview state that the edge-signal
 * stream drives, so it can answer for real rather than plausibly.
 */

import { DISPLAY_OVERLAY_COMMANDS, DISPLAY_OVERLAY_STATUS } from "../../src/shared/contracts/display";
import {
  NOTIFICATION_RESULT_CODES,
  PLATFORM_COMMANDS,
  type NotificationResult,
} from "../../src/shared/contracts/platform";
import { CONTROL_POPUP_STATUS, PREVIEW_COMMANDS } from "../../src/shared/contracts/preview";
import type { ControlPopupResult, ControlPopupStatusCode } from "../../src/shared/contracts/preview";
import { SHELL_COMMANDS } from "../../src/shared/contracts/shell";
import { currentPreviewStatus } from "../events";
import { getWorld } from "../state";
import type { TypedHandlers } from "./types";

/**
 * Tracked so `show`/`hide` answer with the visibility the caller asked for
 * rather than a constant. A popup that reports `visible: false` after a
 * successful show is the kind of fixture that sends someone looking for a
 * bug in the window code.
 */
let popupVisible = false;

export function resetPopupVisibility(): void {
  popupVisible = false;
}

const popup = (
  code: ControlPopupStatusCode,
  message: string,
  visible: boolean,
): ControlPopupResult => {
  popupVisible = visible;
  return { ok: true, code, message, visible };
};

/** `notifications.rs` folds a prompt into `denied`, as the real command does. */
function notificationResult(): NotificationResult {
  return getWorld().shell.notificationPermission === "granted"
    ? { status: "shown" }
    : {
        status: "denied",
        code: NOTIFICATION_RESULT_CODES.PERMISSION_DENIED,
        message: "Notification permission not yet granted",
      };
}

export const windowlessHandlers = {
  [PREVIEW_COMMANDS.OPEN_CONTROL_POPUP]: () =>
    popup(CONTROL_POPUP_STATUS.OPENED, "Popup created (no window in a browser tab)", popupVisible),
  [PREVIEW_COMMANDS.SHOW_CONTROL_POPUP]: () =>
    popup(CONTROL_POPUP_STATUS.SHOWN, "Popup shown (no window in a browser tab)", true),
  [PREVIEW_COMMANDS.HIDE_CONTROL_POPUP]: () =>
    popup(CONTROL_POPUP_STATUS.HIDDEN, "Popup hidden", false),

  /** Real, not plausible: the stream in `events.ts` is what defines it. */
  [PREVIEW_COMMANDS.GET_PREVIEW_STATUS]: () => currentPreviewStatus(),

  [DISPLAY_OVERLAY_COMMANDS.OPEN_DISPLAY_OVERLAY]: () => ({
    ok: true,
    code: DISPLAY_OVERLAY_STATUS.OPENED,
    message: "Overlay opened (no second window in a browser tab)",
    reason: null,
  }),
  [DISPLAY_OVERLAY_COMMANDS.CLOSE_DISPLAY_OVERLAY]: () => ({
    ok: true,
    code: DISPLAY_OVERLAY_STATUS.CLOSED,
    message: "Overlay closed",
    reason: null,
  }),
  [DISPLAY_OVERLAY_COMMANDS.UPDATE_DISPLAY_OVERLAY_PREVIEW]: () => ({
    ok: true,
    code: DISPLAY_OVERLAY_STATUS.PREVIEW_SYNCED,
    message: "Overlay preview synced",
    reason: null,
  }),

  // `plugin:notification|*` is answered separately and drives the permission
  // state; these are the Rust-side commands, answered in `NotificationResult`
  // terms read off the same permission. They used to return `null` and the
  // raw permission string, shapes `notifications.rs` never sends.
  [PLATFORM_COMMANDS.SHOW_NOTIFICATION]: () => notificationResult(),
  [PLATFORM_COMMANDS.REQUEST_NOTIFICATION_PERMISSION]: () => notificationResult(),
  [PLATFORM_COMMANDS.OPEN_LOG_DIR]: () => null,

  /** Fired during bootstrap on every launch, which is how this was found. */
  [SHELL_COMMANDS.UPDATE_TRAY_LABELS]: () => null,
} satisfies TypedHandlers;
