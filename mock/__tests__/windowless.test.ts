/**
 * These eleven commands were listed as "answered, the calling state machine
 * advances" and were not answered at all — the list they sat in only fed a
 * compile-time guard, so `handlerFor` returned `undefined` and the browser
 * branch threw. `update_tray_labels` fires during bootstrap, so that was an
 * unhandled rejection on every launch.
 *
 * A type check cannot catch that: the handler table compiled fine, because
 * the failure was a command being absent from it rather than wrong in it. So
 * the guard has to be a runtime one, and it asserts the thing that was false —
 * that every command the contracts declare is actually answerable.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { DISPLAY_OVERLAY_COMMANDS } from "../../src/shared/contracts/display";
import { PLATFORM_COMMANDS } from "../../src/shared/contracts/platform";
import { PREVIEW_COMMANDS, PREVIEW_STATUS } from "../../src/shared/contracts/preview";
import { SHELL_COMMANDS } from "../../src/shared/contracts/shell";
import { handlerFor, INTENTIONALLY_UNMAPPED, PASSTHROUGH_COMMANDS } from "../handlers";
import { SCENARIOS } from "../scenarios";
import { setWorld } from "../state";
import { resetPreviewSession } from "../handlers/windowless";

beforeEach(() => {
  setWorld(SCENARIOS.furnished.build());
  resetPreviewSession();
});

const call = (command: string) => {
  const handler = handlerFor(command);
  expect(handler, `no handler for ${command}`).toBeDefined();
  return handler?.(undefined);
};

describe("commands whose effect needs a window the browser does not have", () => {
  it("answers the bootstrap tray push instead of throwing", () => {
    // The one that made this visible: it runs on every launch, before the
    // user touches anything.
    expect(() => call(SHELL_COMMANDS.UPDATE_TRAY_LABELS)).not.toThrow();
  });

  it.each([
    PREVIEW_COMMANDS.OPEN_PREVIEW,
    PREVIEW_COMMANDS.CLOSE_PREVIEW,
    DISPLAY_OVERLAY_COMMANDS.OPEN_DISPLAY_OVERLAY,
    DISPLAY_OVERLAY_COMMANDS.CLOSE_DISPLAY_OVERLAY,
    DISPLAY_OVERLAY_COMMANDS.UPDATE_DISPLAY_OVERLAY_PREVIEW,
    PLATFORM_COMMANDS.SHOW_NOTIFICATION,
    PLATFORM_COMMANDS.REQUEST_NOTIFICATION_PERMISSION,
    PLATFORM_COMMANDS.OPEN_LOG_DIR,
  ])("answers %s", (command) => {
    expect(() => call(command)).not.toThrow();
  });

  it("reads back the session the caller just opened, hid and closed", () => {
    expect(call(PREVIEW_COMMANDS.OPEN_PREVIEW)).toMatchObject({
      session: { state: "live", popupHidden: false },
      status: { code: PREVIEW_STATUS.OPENED },
    });
    expect(handlerFor(PREVIEW_COMMANDS.SET_POPUP_HIDDEN)?.({ payload: { hidden: true } })).toMatchObject({
      session: { state: "live", popupHidden: true },
    });
    expect(call(PREVIEW_COMMANDS.OPEN_PREVIEW)).toMatchObject({
      session: { popupHidden: false },
      status: { code: PREVIEW_STATUS.ALREADY_OPEN },
    });
    expect(call(PREVIEW_COMMANDS.CLOSE_PREVIEW)).toMatchObject({
      session: { state: "closed" },
      status: { code: PREVIEW_STATUS.CLOSED },
    });
    expect(call(PREVIEW_COMMANDS.CLOSE_PREVIEW)).toMatchObject({ status: { code: PREVIEW_STATUS.NOT_OPEN } });
  });

  it("leaves nothing on the unmapped list without a runtime answer", () => {
    // The list is allowed to be non-empty again, but anything on it is a
    // command that throws in the browser — which is what this file exists to
    // stop being an accident.
    expect(INTENTIONALLY_UNMAPPED).toEqual([]);
  });

  it("does not answer the commands that must reach the real backend", () => {
    // The mirror of the above: a fixture for these would make the one control
    // with genuine backend consequences the fakest thing in the app.
    for (const command of PASSTHROUGH_COMMANDS) {
      expect(handlerFor(command), `${command} must stay unhandled`).toBeUndefined();
    }
  });
});
