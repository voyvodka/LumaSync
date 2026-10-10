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
 * The preview session is tracked rather than answered with a constant, so
 * open → hide → close reads back what the caller did.
 */

import { DISPLAY_OVERLAY_COMMANDS, DISPLAY_OVERLAY_STATUS } from "../../src/shared/contracts/display";
import {
  NOTIFICATION_RESULT_CODES,
  PLATFORM_COMMANDS,
  type NotificationResult,
} from "../../src/shared/contracts/platform";
import { PREVIEW_COMMANDS, PREVIEW_STATUS } from "../../src/shared/contracts/preview";
import type {
  PreviewSession,
  PreviewSessionResult,
  PreviewStatusCode,
} from "../../src/shared/contracts/preview";
import { SHELL_COMMANDS } from "../../src/shared/contracts/shell";
import { attachTwinChannel, mockTwinLayout } from "../events";
import { getWorld } from "../state";
import type { TypedHandlers } from "./types";

let session: PreviewSession = { state: "closed" };

export function resetPreviewSession(): void {
  session = { state: "closed" };
}

const sessionResult = (code: PreviewStatusCode, message: string): PreviewSessionResult => ({
  session,
  status: { code, message, details: null },
});

/** Where the twin would go: the saved display, else the first one. */
function previewDisplayId(): string {
  const world = getWorld();
  return world.shellState.selectedDisplayId || world.displays[0]?.id || "display-1";
}

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
  [PREVIEW_COMMANDS.OPEN_PREVIEW]: () => {
    if (session.state === "live") {
      session = { ...session, popupHidden: false };
      return sessionResult(PREVIEW_STATUS.ALREADY_OPEN, "The preview is already open.");
    }
    session = { state: "live", displayId: previewDisplayId(), popupHidden: false };
    return sessionResult(PREVIEW_STATUS.OPENED, "Preview opened (no window in a browser tab)");
  },
  [PREVIEW_COMMANDS.CLOSE_PREVIEW]: () => {
    if (session.state === "closed") return sessionResult(PREVIEW_STATUS.NOT_OPEN, "No preview is open.");
    session = { state: "closed" };
    return sessionResult(PREVIEW_STATUS.CLOSED, "Preview closed.");
  },
  /** Real, not plausible: the DevPanel's frame stream feeds this channel. */
  [PREVIEW_COMMANDS.SUBSCRIBE_TWIN_FRAMES]: ({ onFrame }) => {
    if (session.state === "closed") {
      return { layout: null, status: { code: PREVIEW_STATUS.NOT_OPEN, message: "No preview twin is open.", details: null } };
    }
    attachTwinChannel(onFrame);
    return {
      layout: mockTwinLayout(),
      status: { code: PREVIEW_STATUS.TWIN_SUBSCRIBED, message: "Twin frames subscribed.", details: null },
    };
  },
  [PREVIEW_COMMANDS.SET_POPUP_HIDDEN]: ({ payload }) => {
    if (session.state === "closed") return sessionResult(PREVIEW_STATUS.NOT_OPEN, "No preview is open.");
    session = { ...session, popupHidden: payload.hidden };
    return sessionResult(PREVIEW_STATUS.POPUP_UPDATED, "Preview controls updated.");
  },

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
