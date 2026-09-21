/**
 * The command table, and the guard that keeps it honest.
 *
 * Every command the contracts declare must be in exactly one of three places:
 * a handler here, `PASSTHROUGH_COMMANDS`, or `INTENTIONALLY_UNMAPPED` with a
 * reason. The type assertions at the bottom fail `bun run typecheck:mock` when
 * one is missing — which is the whole point, because the alternative is a new
 * Rust command quietly answering `undefined` for a week.
 *
 * The union is derived from the same `*COMMANDS` maps that
 * `verify:shell-contracts` pins against `generate_handler!`, so the chain is
 * closed end to end: new Rust command → the verifier forces a contract entry →
 * the union grows → this file stops compiling until someone decides what the
 * mock should answer.
 */

import { CAPTURE_COMMANDS } from "../../src/shared/contracts/capture";
import { DEVICE_COMMANDS } from "../../src/shared/contracts/device";
import { DISPLAY_OVERLAY_COMMANDS } from "../../src/shared/contracts/display";
import { HUE_COMMANDS, HUE_DEBUG_COMMANDS } from "../../src/shared/contracts/hue";
import { PLATFORM_COMMANDS } from "../../src/shared/contracts/platform";
import { PREVIEW_COMMANDS } from "../../src/shared/contracts/preview";
import { HUE_ZONE_COMMANDS, ROOM_MAP_COMMANDS } from "../../src/shared/contracts/roomMap";
import { SHELL_COMMANDS } from "../../src/shared/contracts/shell";
import { UPDATER_COMMANDS } from "../../src/shared/contracts/updater";

import { deviceHandlers } from "./device";
import { hueHandlers } from "./hue";
import { pluginHandlers, shellHandlers, windowPluginHandler } from "./shell";
import type { Handler } from "./types";

const COMMAND_MAPS = [
  CAPTURE_COMMANDS,
  DEVICE_COMMANDS,
  DISPLAY_OVERLAY_COMMANDS,
  HUE_COMMANDS,
  HUE_ZONE_COMMANDS,
  PLATFORM_COMMANDS,
  PREVIEW_COMMANDS,
  ROOM_MAP_COMMANDS,
  SHELL_COMMANDS,
  UPDATER_COMMANDS,
] as const;

type ValuesOf<T> = T extends Readonly<Record<string, infer V>> ? V : never;

/** Every command name the contracts declare. */
export type TauriCommandName = ValuesOf<(typeof COMMAND_MAPS)[number]>;

/**
 * Forwarded to the real backend even while everything else is mocked.
 *
 * `simulate_hue_fault` fires the shutdown signal on a live DTLS stream and
 * drives the real reconnect monitor. A fixture would return the same status
 * code and prove nothing, which would make the one control with genuine
 * backend consequences the fakest thing in the app.
 *
 * The zone commands are pure functions of their request — they validate and
 * echo back the mutated zones. Faking them makes every drag in the room map
 * vanish, so under `tauri dev` they reach the real implementation for free.
 */
export const PASSTHROUGH_COMMANDS = [
  HUE_DEBUG_COMMANDS.SIMULATE_FAULT,
  HUE_ZONE_COMMANDS.CREATE_HUE_ZONE,
  HUE_ZONE_COMMANDS.UPDATE_HUE_ZONE,
  HUE_ZONE_COMMANDS.DELETE_HUE_ZONE,
  HUE_ZONE_COMMANDS.ASSIGN_CHANNEL_TO_HUE_ZONE,
  ROOM_MAP_COMMANDS.COPY_BACKGROUND_IMAGE,
] as const;

export type PassthroughCommandName = (typeof PASSTHROUGH_COMMANDS)[number];

/**
 * Answered, but the visible effect cannot exist here — each addresses a
 * separate webview window, or an OS surface the browser has no access to. The
 * calling state machine advances and the buttons are exercisable; nothing
 * appears. Listed rather than handled so the gap is a decision on the record.
 */
export const INTENTIONALLY_UNMAPPED = [
  PREVIEW_COMMANDS.OPEN_CONTROL_POPUP,
  PREVIEW_COMMANDS.SHOW_CONTROL_POPUP,
  PREVIEW_COMMANDS.HIDE_CONTROL_POPUP,
  PREVIEW_COMMANDS.GET_PREVIEW_STATUS,
  DISPLAY_OVERLAY_COMMANDS.OPEN_DISPLAY_OVERLAY,
  DISPLAY_OVERLAY_COMMANDS.CLOSE_DISPLAY_OVERLAY,
  DISPLAY_OVERLAY_COMMANDS.UPDATE_DISPLAY_OVERLAY_PREVIEW,
  PLATFORM_COMMANDS.SHOW_NOTIFICATION,
  PLATFORM_COMMANDS.REQUEST_NOTIFICATION_PERMISSION,
  PLATFORM_COMMANDS.OPEN_LOG_DIR,
  SHELL_COMMANDS.UPDATE_TRAY_LABELS,
  HUE_COMMANDS.MIGRATE_CREDENTIALS,
] as const;

export type UnmappedCommandName = (typeof INTENTIONALLY_UNMAPPED)[number];

const staticHandlers: Record<string, Handler> = {
  ...deviceHandlers,
  ...hueHandlers,
  ...shellHandlers,
  ...pluginHandlers,
};

export function handlerFor(command: string): Handler | undefined {
  return staticHandlers[command] ?? windowPluginHandler(command);
}

export const handlers = staticHandlers;

// --- The guard -------------------------------------------------------------
//
// A command that is neither handled, passed through, nor listed as unmapped
// makes `Uncovered` non-never, and the assignment below stops compiling. The
// error names the command, because it is the literal type that fails.

type Covered = PassthroughCommandName | UnmappedCommandName | HandledCommandName;
type Uncovered = Exclude<TauriCommandName, Covered>;

/** The commands with a fixture above, as literal types rather than `string`. */
type HandledCommandName =
  | ValuesOf<typeof DEVICE_COMMANDS>
  | Exclude<ValuesOf<typeof HUE_COMMANDS>, typeof HUE_COMMANDS.MIGRATE_CREDENTIALS>
  | typeof DISPLAY_OVERLAY_COMMANDS.LIST_DISPLAYS
  | ValuesOf<typeof CAPTURE_COMMANDS>
  | typeof PREVIEW_COMMANDS.OPEN_TWIN_OVERLAY
  | typeof PREVIEW_COMMANDS.CLOSE_TWIN_OVERLAY
  | typeof PREVIEW_COMMANDS.START_TEST_PATTERN
  | typeof PREVIEW_COMMANDS.STOP_TEST_PATTERN
  | ValuesOf<typeof UPDATER_COMMANDS>;

// If this line errors, read the type it reports: that command needs a fixture,
// a passthrough entry, or a listed reason.
export const EVERY_COMMAND_IS_ACCOUNTED_FOR: Uncovered extends never ? true : Uncovered = true;
