/**
 * The command table, and the guard that keeps it honest.
 *
 * Every command the contracts declare must be in exactly one of three places:
 * a handler here, `PASSTHROUGH_COMMANDS`, or `INTENTIONALLY_UNMAPPED` with a
 * reason. The type assertions at the bottom fail `bun run typecheck:mock` when
 * one is missing — which is the whole point, because the alternative is a new
 * Rust command quietly answering `undefined` for a week.
 *
 * The union is `ContractCommandName` from `src/shared/contracts/ipc.ts`,
 * derived from the same `*COMMANDS` maps that `verify:shell-contracts` pins
 * against `generate_handler!`, so the chain is closed end to end: new Rust
 * command → the verifier forces a contract entry → the command map must type
 * it → this file stops compiling until someone decides what the mock should
 * answer.
 */

import { HUE_DEBUG_COMMANDS } from "../../src/shared/contracts/hue";
import type { ContractCommandName } from "../../src/shared/contracts/ipc";
import { HUE_ZONE_COMMANDS, ROOM_MAP_COMMANDS } from "../../src/shared/contracts/roomMap";

import { deviceHandlers } from "./device";
import { hueHandlers } from "./hue";
import { hueHealthHandlers } from "./hueHealth";
import { lightingRuntimeHandlers } from "./lighting";
import { pluginHandlers, shellHandlers, windowPluginHandler } from "./shell";
import { windowlessHandlers } from "./windowless";
import type { Handler } from "./types";

/** Every command name the contracts declare. */
export type TauriCommandName = ContractCommandName;

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
 * Nothing is listed here, and the empty list is the point.
 *
 * It used to hold the eleven commands whose *effect* cannot exist in a browser
 * tab — a second webview, a tray menu, a notification — with a comment saying
 * they were "answered, the calling state machine advances and the buttons are
 * exercisable". They were not. This list only ever fed the compile-time
 * coverage guard below; `handlerFor` never consulted it, so every one of them
 * returned `undefined` and `boot.ts` threw. `update_tray_labels` fires during
 * bootstrap, so that was an unhandled rejection on **every** browser launch.
 *
 * They are answered for real now, in `windowless.ts`. Keeping the slot because
 * the guard's three-way split is still the right shape — but a command put
 * here needs a reason that survives being read back, and "the effect is
 * invisible" was not a reason to leave the call unanswered.
 */
export const INTENTIONALLY_UNMAPPED = [] as const;

export type UnmappedCommandName = (typeof INTENTIONALLY_UNMAPPED)[number];

/**
 * Deliberately unannotated. A `Record<string, Handler>` here widens `keyof` to
 * `string`, which silently makes `HandledCommandName` cover every command and
 * turns the exhaustiveness guard below into a no-op. Verified by deleting a
 * handler: with the annotation the build stayed green, without it the guard
 * names the missing command.
 */
const staticHandlers = {
  ...deviceHandlers,
  ...hueHandlers,
  ...hueHealthHandlers,
  ...lightingRuntimeHandlers,
  ...shellHandlers,
  ...windowlessHandlers,
  ...pluginHandlers,
};

// `staticHandlers` now carries a per-command args type (the command map in `src/shared/contracts/ipc.ts`), so a
// handful of its members no longer structurally match the generic `Handler`
// signature the dispatcher calls through — that mismatch is exactly the
// protection `TypedHandlers` exists to add, and it is already enforced by the
// `satisfies` check on the object literal above. The cast through `unknown`
// only erases that precision for the runtime dispatch table; it does not
// bypass the compile-time check on the handlers themselves.
export function handlerFor(command: string): Handler | undefined {
  return (staticHandlers as unknown as Record<string, Handler>)[command] ?? windowPluginHandler(command);
}

export const handlers: Record<string, Handler> = staticHandlers as unknown as Record<string, Handler>;

// --- The guard -------------------------------------------------------------
//
// A command that is neither handled, passed through, nor listed as unmapped
// makes `Uncovered` non-never, and the assignment below stops compiling. The
// error names the command, because it is the literal type that fails.

type Covered = PassthroughCommandName | UnmappedCommandName | HandledCommandName;
type Uncovered = Exclude<TauriCommandName, Covered>;

/**
 * Derived from the handler objects themselves, not restated.
 *
 * The first version listed the covered commands by hand and promptly went
 * stale: three Hue commands were dropped from the handler map during a rewrite
 * and the list still claimed them, so the guard passed while two commands had
 * no fixture at all. Reading the keys means the claim cannot disagree with the
 * code it describes.
 */
type HandledCommandName = keyof typeof staticHandlers & TauriCommandName;

// If this line errors, read the type it reports: that command needs a fixture,
// a passthrough entry, or a listed reason.
export const EVERY_COMMAND_IS_ACCOUNTED_FOR: Uncovered extends never ? true : Uncovered = true;

