/**
 * The lighting transaction's fixtures: a small version of `outputs.rs` over
 * the mode apply and stop in `./device.ts` and the Hue fixtures in `./hue.ts`.
 * It keeps the rules a caller can see — Hue up before the mode, Off stops Hue
 * too, a `[usb, hue]` start the Hue gate refuses runs on USB, a choice is
 * saved — and announces every change on `lighting://runtime-changed`, which is what every
 * window renders from.
 */

import { DEVICE_COMMANDS } from "../../src/shared/contracts/device";
import {
  HUE_COMMANDS,
  HUE_FORGET_STATUS,
  HUE_RUNTIME_STATUS,
  type HueRuntimeTarget,
} from "../../src/shared/contracts/hue";
import { HUE_LEFT_OUT_REASON, type HueLeftOutReason } from "../../src/shared/contracts/lighting";
import { LIGHTING_EVENTS } from "../../src/shared/contracts/lightingRuntime";
import {
  LIGHTING_ORIGIN,
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
import { applyLightingMode, stopLightingMode } from "./device";
import { hueHandlers, stopHueStream } from "./hue";
import { removeShellStateKeys, writeShellStateKey } from "./shell";
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
  void emitMockEvent(LIGHTING_EVENTS.RUNTIME_CHANGED, next);
  return next;
}

function emptyOutcome(): ApplyOutputsOutcome {
  return {
    hueStartCode: null,
    hueLeftOut: null,
    hueNotStarted: null,
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
  if (getWorld().hue.streaming) stopHueStream();
}

function releaseHue(): ApplyOutputsResult {
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
}

/** `HUE_BRIDGE_STATE_KEYS` in `commands/hue/forget.rs`. */
const HUE_BRIDGE_STATE_KEYS = [
  "lastHueBridge",
  "lastHueAreaId",
  "hueBridgeSyncedPositions",
  "hueAppKey",
  "hueClientKey",
  "hueCredentialStatus",
  "hueOnboardingStep",
  "credentialStorageBackend",
] as const;

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
      if (current.kind !== "off") stopLightingMode();
      if (choice && request.mode) stopHueIfStreaming();
    } else {
      let run = selection ?? savedTargets();
      if (run.length === 0) {
        const ended = current.kind !== "off";
        if (ended) stopLightingMode();
        stopHueIfStreaming();
        outcome.modeEnded = ended;
        return reply("OUTPUTS_APPLIED", outcome);
      }
      if (run.includes("hue") && !getWorld().hue.streaming) {
        outcome.hueStartCode = hueHandlers[HUE_COMMANDS.START_STREAM]().status.code;
      }
      const payload = (targets: HueRuntimeTarget[]): LightingModeConfig => ({ kind, solid, ambilight, targets });
      let applied = applyLightingMode(payload(run));
      if (applied.status.code === "HUE_NOT_READY" && run.includes("usb") && run.length > 1) {
        if (outcome.hueStartCode === HUE_RUNTIME_STATUS.TRANSIENT_RETRY_SCHEDULED) stopHueIfStreaming();
        run = ["usb"];
        heldOut = HUE_LEFT_OUT_REASON.UNREACHABLE;
        outcome.hueLeftOut = heldOut;
        outcome.droppedTargets = ["hue"];
        selection = run;
        applied = applyLightingMode(payload(run));
      }
      outcome.applyStatus = applied.status;
      if (applied.status.code === "HUE_NOT_READY" && choice && run.length === 1 && run[0] === "hue") {
        outcome.hueNotStarted = HUE_LEFT_OUT_REASON.UNREACHABLE;
      }
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

  [LIGHTING_RUNTIME_COMMANDS.RELEASE_HUE_OUTPUT]: () => releaseHue(),

  // Hue out of the lighting, the saved outputs and the saved pairing, as
  // `forget_hue_bridge` does it.
  [HUE_COMMANDS.FORGET_BRIDGE]: () => {
    releaseHue();
    const saved = savedTargets();
    if (saved.includes("hue")) {
      selection = saved.filter((t) => t !== "hue");
      writeShellStateKey("lastOutputTargets", selection);
    }
    removeShellStateKeys(HUE_BRIDGE_STATE_KEYS);
    mutate((w) => {
      w.hue.appKey = null;
      w.hue.selectedBridgeId = null;
      w.hue.selectedAreaId = null;
    });
    publish();
    return status(HUE_FORGET_STATUS.OK, "The Hue bridge was forgotten.");
  },

  // The local channel loses its device as on an unplug: session only.
  [DEVICE_COMMANDS.FORGET_WLED_DEVICE]: ({ request }) => {
    const world = getWorld();
    if (world.wled.connectedHost === request.ip) {
      const run = selection ?? savedTargets();
      if (run.includes("usb") && world.serial.connectedPort === null) {
        selection = run.filter((t) => t !== "usb");
        if (world.lighting.mode.kind !== "off") {
          if (selection.length === 0) {
            stopLightingMode();
          } else {
            const rest = selection;
            mutate((w) => {
              w.lighting.mode = { ...w.lighting.mode, targets: rest };
            });
          }
        }
      }
      mutate((w) => {
        w.wled.connectedHost = null;
      });
    }
    const savedSink = getWorld().shellState?.lastWledSink;
    if (savedSink?.ip === request.ip) removeShellStateKeys(["lastWledSink"]);
    publish();
    return { status: status("WLED_FORGET_OK", "The WLED device was forgotten.") };
  },

  [LIGHTING_RUNTIME_COMMANDS.GET_LIGHTING_RUNTIME]: () => snapshot(),
} satisfies TypedHandlers;

/** Test seam: the session selection is module state. */
export function __resetMockLightingRuntime(): void {
  selection = null;
  heldOut = null;
}
