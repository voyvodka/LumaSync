/**
 * The lighting transaction's fixtures: a small version of `outputs.rs` over
 * the same `set_lighting_mode` / `stop_lighting` / Hue fixtures the rest of
 * the mock uses, so both paths stay in step with one another. It keeps the
 * rules a caller can see — Hue up before the mode, Off stops Hue too, a
 * `[usb, hue]` start the Hue gate refuses runs on USB, a choice is saved — and
 * announces every change on `lighting://runtime-changed`, which is what every
 * window renders from.
 */

import { DEVICE_COMMANDS } from "../../src/shared/contracts/device";
import { HUE_COMMANDS, HUE_RUNTIME_STATUS, type HueRuntimeTarget } from "../../src/shared/contracts/hue";
import { HUE_LEFT_OUT_REASON, type HueLeftOutReason } from "../../src/shared/contracts/lighting";
import {
  LIGHTING_ORIGIN,
  LIGHTING_RUNTIME_CHANGED_EVENT,
  LIGHTING_RUNTIME_COMMANDS,
  type ApplyOutputsOutcome,
  type ApplyOutputsResult,
  type LightingOrigin,
  type LightingOutputsStatusCode,
  type LightingRuntimeSnapshot,
} from "../../src/shared/contracts/lightingRuntime";
import type { LightingModeConfig } from "../../src/shared/contracts/mode";
import { emitMockEvent } from "../events";
import { getWorld, mutate } from "../state";
import { deviceHandlers } from "./device";
import { hueHandlers } from "./hue";
import { writeShellStateKey } from "./shell";
import { status } from "./status";
import type { TypedHandlers } from "./types";

let revision = 0;
let requestId = 0;
/** The session selection; `null` until a request or the saved targets set it. */
let selection: HueRuntimeTarget[] | null = null;
let heldOut: HueLeftOutReason | null = null;

const CHOICES: readonly LightingOrigin[] = [LIGHTING_ORIGIN.USER, LIGHTING_ORIGIN.TRAY, LIGHTING_ORIGIN.POPUP];

function savedTargets(): HueRuntimeTarget[] {
  const saved = getWorld().shellState?.lastOutputTargets;
  return Array.isArray(saved) && saved.length > 0 ? [...saved] : ["usb"];
}

function snapshot(): LightingRuntimeSnapshot {
  const { lighting, hue } = getWorld();
  const mode = lighting.mode;
  const targets: HueRuntimeTarget[] = mode.targets?.length ? mode.targets : ["usb"];
  revision += 1;
  return {
    revision,
    mode,
    active: mode.kind !== "off",
    activeTargets: mode.kind === "off" ? [] : targets.filter((t) => t !== "hue" || hue.streaming),
    selectedTargets: selection ?? savedTargets(),
    phase: "idle",
    requestId: requestId || null,
    hueHeldOutReason: heldOut,
    bootHueRetry: null,
  };
}

function publish(): LightingRuntimeSnapshot {
  const next = snapshot();
  void emitMockEvent(LIGHTING_RUNTIME_CHANGED_EVENT, next);
  return next;
}

function emptyOutcome(): ApplyOutputsOutcome {
  return {
    hueStartCode: null,
    hueLeftOut: null,
    applyStatus: null,
    stopFailed: [],
    droppedTargets: [],
    modeEnded: false,
  };
}

function reply(
  code: LightingOutputsStatusCode,
  outcome: ApplyOutputsOutcome,
  details: string | null = null,
): ApplyOutputsResult {
  requestId += 1;
  return {
    status: status(code, "Mock lighting transaction", details),
    requestId,
    snapshot: publish(),
    outcome,
  };
}

function stopHueIfStreaming(): void {
  if (getWorld().hue.streaming) hueHandlers[HUE_COMMANDS.STOP_STREAM]();
}

export const lightingRuntimeHandlers = {
  [LIGHTING_RUNTIME_COMMANDS.APPLY_OUTPUTS]: (args) => {
    const { request } = args;
    const outcome = emptyOutcome();

    if (request.origin === LIGHTING_ORIGIN.LEASE_HUE) {
      if (request.targets?.includes("hue") && !getWorld().hue.streaming) {
        outcome.hueStartCode = hueHandlers[HUE_COMMANDS.START_STREAM]().status.code;
      }
      return reply("OUTPUTS_APPLIED", outcome);
    }

    const choice = CHOICES.includes(request.origin);
    if (request.targets) {
      selection = [...request.targets];
      if (choice) writeShellStateKey("lastOutputTargets", selection);
    }
    if (choice && (request.mode || request.targets)) heldOut = null;

    const current = getWorld().lighting.mode;
    const kind = request.mode?.kind ?? current.kind;
    const solid = request.mode?.solid ?? current.solid;
    const ambilight = request.mode?.ambilight ?? current.ambilight;

    if (kind === "off") {
      if (current.kind !== "off") deviceHandlers[DEVICE_COMMANDS.STOP_LIGHTING]();
      if (choice && request.mode) stopHueIfStreaming();
    } else {
      let run = selection ?? savedTargets();
      if (run.length === 0) {
        const ended = current.kind !== "off";
        if (ended) deviceHandlers[DEVICE_COMMANDS.STOP_LIGHTING]();
        stopHueIfStreaming();
        outcome.modeEnded = ended;
        return reply("OUTPUTS_APPLIED", outcome);
      }
      if (run.includes("hue") && !getWorld().hue.streaming) {
        outcome.hueStartCode = hueHandlers[HUE_COMMANDS.START_STREAM]().status.code;
      }
      const payload = (targets: HueRuntimeTarget[]): LightingModeConfig => ({ kind, solid, ambilight, targets });
      let applied = deviceHandlers[DEVICE_COMMANDS.SET_LIGHTING_MODE]({ payload: payload(run) });
      if (applied.status.code === "HUE_NOT_READY" && run.includes("usb") && run.length > 1) {
        if (outcome.hueStartCode === HUE_RUNTIME_STATUS.TRANSIENT_RETRY_SCHEDULED) stopHueIfStreaming();
        run = ["usb"];
        heldOut = HUE_LEFT_OUT_REASON.UNREACHABLE;
        outcome.hueLeftOut = heldOut;
        outcome.droppedTargets = ["hue"];
        selection = run;
        applied = deviceHandlers[DEVICE_COMMANDS.SET_LIGHTING_MODE]({ payload: payload(run) });
      }
      outcome.applyStatus = applied.status;
      if (applied.mode.kind !== kind) {
        if (!run.includes("hue") || applied.mode.kind === "off") stopHueIfStreaming();
        return reply(
          applied.mode.kind === "off" && current.kind !== "off" ? "OUTPUTS_START_FAILED" : "OUTPUTS_REFUSED",
          outcome,
          applied.status.details ?? applied.status.code,
        );
      }
      mutate((w) => {
        w.lighting.mode = { ...w.lighting.mode, solid, ambilight };
      });
    }

    if (choice && request.mode) {
      writeShellStateKey("lightingMode", { kind, solid, ambilight, targets: savedTargets() });
    }
    return reply(outcome.hueLeftOut ? "OUTPUTS_APPLIED_PARTIAL" : "OUTPUTS_APPLIED", outcome);
  },

  [LIGHTING_RUNTIME_COMMANDS.RETUNE_LIGHTING]: (args) => {
    const mode = getWorld().lighting.mode;
    const kind = args.tuning.solid ? "solid" : args.tuning.ambilight ? "ambilight" : null;
    if (kind === null || mode.kind !== kind) {
      return { status: status("RETUNE_NOT_RUNNING", "Nothing of that kind is running") };
    }
    mutate((w) => {
      w.lighting.mode = {
        ...w.lighting.mode,
        solid: args.tuning.solid ?? w.lighting.mode.solid,
        ambilight: args.tuning.ambilight ?? w.lighting.mode.ambilight,
      };
    });
    publish();
    return { status: status("RETUNE_APPLIED", "Retuned") };
  },

  [LIGHTING_RUNTIME_COMMANDS.RELEASE_HUE_OUTPUT]: () => {
    const outcome = emptyOutcome();
    mutate((w) => {
      w.hue.streaming = false;
      w.hue.stopped = true;
      const remaining = (w.lighting.mode.targets ?? []).filter((t) => t !== "hue");
      if (w.lighting.mode.kind !== "off" && remaining.length === 0) outcome.modeEnded = true;
      w.lighting.mode =
        remaining.length > 0
          ? { ...w.lighting.mode, targets: remaining }
          : { ...w.lighting.mode, kind: "off" };
    });
    return reply("OUTPUTS_APPLIED", outcome);
  },

  [LIGHTING_RUNTIME_COMMANDS.GET_LIGHTING_RUNTIME]: () => snapshot(),
} satisfies TypedHandlers;

/** Test seam: the session selection is module state. */
export function __resetMockLightingRuntime(): void {
  selection = null;
  heldOut = null;
}
