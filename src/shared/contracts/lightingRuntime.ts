/**
 * The Rust lighting transaction: one command reconciles the running mode and
 * its outputs toward what the user asked for, and one snapshot says what is
 * running. See docs/architecture/lighting-transaction.md.
 *
 * Rust handoff: `src-tauri/src/commands/lighting_mode/outputs.rs`,
 * `snapshot.rs` and `tuning.rs`.
 */

import type { HueRuntimeTarget, HueRuntimeTriggerSource } from "./hue";
import type { HueLeftOutReason, LightingModeStatusCode } from "./lighting";
import type { AmbilightPayload, LightingModeConfig, SolidColorPayload } from "./mode";
import type { CommandStatusOf } from "./status";

export const LIGHTING_RUNTIME_COMMANDS = {
  APPLY_OUTPUTS: "apply_outputs",
  RETUNE_LIGHTING: "retune_lighting",
  RELEASE_HUE_OUTPUT: "release_hue_output",
  GET_LIGHTING_RUNTIME: "get_lighting_runtime",
} as const;

/** Broadcast to every window whenever the snapshot's revision moves. */
export const LIGHTING_RUNTIME_CHANGED_EVENT = "lighting://runtime-changed";

export const LIGHTING_EVENTS = {
  RUNTIME_CHANGED: LIGHTING_RUNTIME_CHANGED_EVENT,
} as const;

export type LightingEventName = (typeof LIGHTING_EVENTS)[keyof typeof LIGHTING_EVENTS];

/**
 * Who asked. Decides what the transaction may persist and a few boot-only
 * rules; it never changes how the outputs are reconciled.
 *
 * - `user`, `tray`, `popup` — a choice: the targets are saved on arrival, the
 *   mode once it runs.
 * - `boot` — the launch restore. Nothing is saved; a `usb` target is kept only
 *   if a strip or a WLED sink is there; a busy Hue area is waited out once.
 * - `usbUnplug` — the strip went away. Session only: nothing is saved.
 * - `leaseHue` — a test pattern borrowing the Hue stream. `targets` naming
 *   `hue` acquires, anything else releases; the mode is never touched.
 */
export const LIGHTING_ORIGIN = {
  USER: "user",
  TRAY: "tray",
  POPUP: "popup",
  BOOT: "boot",
  USB_UNPLUG: "usbUnplug",
  LEASE_HUE: "leaseHue",
} as const;

export type LightingOrigin = (typeof LIGHTING_ORIGIN)[keyof typeof LIGHTING_ORIGIN];

/** `ApplyOutputsResult.status.code`, from `outputs_status` in `outputs.rs`. */
export const LIGHTING_OUTPUTS_STATUS = {
  /** Everything asked for is running. */
  OUTPUTS_APPLIED: "OUTPUTS_APPLIED",
  /** The mode runs, but not on every target asked for — `outcome` says which and why. */
  OUTPUTS_APPLIED_PARTIAL: "OUTPUTS_APPLIED_PARTIAL",
  /** A gate refused before anything was torn down; the previous mode still runs. */
  OUTPUTS_REFUSED: "OUTPUTS_REFUSED",
  /** The previous mode was torn down and the new one did not start: nothing runs. */
  OUTPUTS_START_FAILED: "OUTPUTS_START_FAILED",
  /** A newer request took over; this one touched no hardware after that point. */
  OUTPUTS_SUPERSEDED: "OUTPUTS_SUPERSEDED",
  /** A `usb` target has no LED calibration; nothing was touched. */
  OUTPUTS_CALIBRATION_REQUIRED: "OUTPUTS_CALIBRATION_REQUIRED",
  /** The app is quitting; nothing new is started. */
  OUTPUTS_SHUTTING_DOWN: "OUTPUTS_SHUTTING_DOWN",
  /** `targets` named an output that does not exist; nothing was recorded, saved or touched. */
  OUTPUTS_INVALID_REQUEST: "OUTPUTS_INVALID_REQUEST",
} as const;

export type LightingOutputsStatusCode =
  (typeof LIGHTING_OUTPUTS_STATUS)[keyof typeof LIGHTING_OUTPUTS_STATUS];

/** `RetuneLightingResult.status.code`, from `retune_status` in `tuning.rs`. */
export const LIGHTING_RETUNE_STATUS = {
  /** Reached the running outputs. */
  RETUNE_APPLIED: "RETUNE_APPLIED",
  /** Stored; the transaction in flight applies it when it commits. */
  RETUNE_DEFERRED: "RETUNE_DEFERRED",
  /** Stored for the next start; nothing of that kind is running. */
  RETUNE_NOT_RUNNING: "RETUNE_NOT_RUNNING",
} as const;

export type LightingRetuneStatusCode =
  (typeof LIGHTING_RETUNE_STATUS)[keyof typeof LIGHTING_RETUNE_STATUS];

export const LIGHTING_RUNTIME_PHASE = {
  IDLE: "idle",
  STARTING_HUE: "startingHue",
  APPLYING: "applying",
  STOPPING: "stopping",
} as const;

export type LightingRuntimePhase =
  (typeof LIGHTING_RUNTIME_PHASE)[keyof typeof LIGHTING_RUNTIME_PHASE];

/** The launch restore's wait for a held Hue area. */
export const BOOT_HUE_RETRY_STATE = {
  WAITING: "waiting",
  GAVE_UP: "gaveUp",
} as const;

export type BootHueRetryState = (typeof BOOT_HUE_RETRY_STATE)[keyof typeof BOOT_HUE_RETRY_STATE];

export interface ApplyOutputsRequest {
  /** Absent keeps the requested mode; `solid` / `ambilight` absent keep the last ones. */
  mode?: LightingModeConfig | null;
  /** Absent keeps the selection. */
  targets?: HueRuntimeTarget[] | null;
  origin: LightingOrigin;
}

/** What `lighting://runtime-changed` carries and `get_lighting_runtime` returns. */
export interface LightingRuntimeSnapshot {
  /** Strictly increasing; a listener drops anything older than what it holds. */
  revision: number;
  /** The mode the backend runs — never the one asked for. */
  mode: LightingModeConfig;
  active: boolean;
  /** The outputs being driven, plus a Hue stream whose stop did not confirm. */
  activeTargets: HueRuntimeTarget[];
  /** The selection for this session; a left-out target drops from it, not from what is saved. */
  selectedTargets: HueRuntimeTarget[];
  phase: LightingRuntimePhase;
  /** The transaction in flight, or the last one to finish. */
  requestId: number | null;
  /** Why Hue is out of the running mode. Held until Hue joins or a new choice is made. */
  hueHeldOutReason: HueLeftOutReason | null;
  bootHueRetry: BootHueRetryState | null;
  /** The answer to the newest choice that ran to an end, from any window or the tray. */
  lastOutcome: LightingOutcome | null;
}

export interface ApplyOutputsOutcome {
  /** What `start_hue_stream` answered, when this transaction asked. */
  hueStartCode: string | null;
  /** Hue was left out of a mode that runs on USB. */
  hueLeftOut: HueLeftOutReason | null;
  /** A user choice named Hue alone and Hue did not start, so nothing new runs. */
  hueNotStarted: HueLeftOutReason | null;
  /** The last mode apply's status, when one ran — the start-failure reason is in its `details`. */
  applyStatus: CommandStatusOf<LightingModeStatusCode> | null;
  /** Targets whose stop did not confirm; they stay in `activeTargets`. */
  stopFailed: HueRuntimeTarget[];
  /** A target the mode could not start on, dropped from the selection for this session. */
  droppedTargets: HueRuntimeTarget[];
  /** The running mode ended rather than a target: nothing was left to run on. */
  modeEnded: boolean;
}

/**
 * A choice's answer, published with the snapshot so a surface that did not
 * make the choice can still say what happened: the main window raises the
 * notice for a popup or tray choice, and an OS notification when a tray choice
 * fails while it is hidden. Only `user`, `popup` and `tray` requests publish
 * one; a superseded request publishes none, since the newer one answers.
 * `requestId` only grows, so a surface that handled one never raises it again.
 */
export interface LightingOutcome {
  requestId: number;
  origin: LightingOrigin;
  status: CommandStatusOf<LightingOutputsStatusCode>;
  outcome: ApplyOutputsOutcome;
}

export interface ApplyOutputsResult {
  status: CommandStatusOf<LightingOutputsStatusCode>;
  requestId: number;
  snapshot: LightingRuntimeSnapshot;
  outcome: ApplyOutputsOutcome;
}

/** A settings nudge within the running kind. Exactly one of the two is read. */
export interface LightingTuning {
  solid?: SolidColorPayload | null;
  ambilight?: AmbilightPayload | null;
}

export interface RetuneLightingResult {
  status: CommandStatusOf<LightingRetuneStatusCode>;
}

/** `release_hue_output`'s argument; the stop is attributed to it. */
export type ReleaseHueTrigger = HueRuntimeTriggerSource;
