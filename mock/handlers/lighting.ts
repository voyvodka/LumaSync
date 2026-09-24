/**
 * The lighting transaction's fixtures. The mock has no transaction of its own:
 * `apply_outputs` runs the request through the same `set_lighting_mode` /
 * `stop_lighting` fixtures the rest of the mock uses, and the snapshot is read
 * off the world, so both paths stay in step with one another.
 */

import { DEVICE_COMMANDS } from "../../src/shared/contracts/device";
import type { HueRuntimeTarget } from "../../src/shared/contracts/hue";
import {
  LIGHTING_RUNTIME_COMMANDS,
  type ApplyOutputsResult,
  type LightingOutputsStatusCode,
  type LightingRuntimeSnapshot,
} from "../../src/shared/contracts/lightingRuntime";
import { getWorld, mutate } from "../state";
import { deviceHandlers } from "./device";
import { status } from "./status";
import type { TypedHandlers } from "./types";

let revision = 0;

function snapshot(requestId: number | null): LightingRuntimeSnapshot {
  const { lighting, hue } = getWorld();
  const mode = lighting.mode;
  const targets: HueRuntimeTarget[] = mode.targets?.length ? mode.targets : ["usb"];
  revision += 1;
  return {
    revision,
    mode,
    active: mode.kind !== "off",
    activeTargets:
      mode.kind === "off" ? [] : targets.filter((t) => t !== "hue" || hue.streaming),
    selectedTargets: mode.targets ?? [],
    phase: "idle",
    requestId,
    hueHeldOutReason: null,
    bootHueRetry: null,
  };
}

function result(code: LightingOutputsStatusCode, details: string | null = null): ApplyOutputsResult {
  const requestId = revision + 1;
  return {
    status: status(code, "Mock lighting transaction", details),
    requestId,
    snapshot: snapshot(requestId),
    outcome: {
      hueStartCode: null,
      hueLeftOut: null,
      applyStatus: null,
      stopFailed: [],
      droppedTargets: [],
      modeEnded: false,
    },
  };
}

export const lightingRuntimeHandlers = {
  [LIGHTING_RUNTIME_COMMANDS.APPLY_OUTPUTS]: (args) => {
    const current = getWorld().lighting.mode;
    const mode = args.request.mode ?? current;
    const targets = args.request.targets ?? current.targets;
    const reply =
      mode.kind === "off"
        ? deviceHandlers[DEVICE_COMMANDS.STOP_LIGHTING]()
        : deviceHandlers[DEVICE_COMMANDS.SET_LIGHTING_MODE]({ payload: { ...mode, targets } });
    const ran = reply.mode.kind === mode.kind;
    const code: LightingOutputsStatusCode = ran
      ? "OUTPUTS_APPLIED"
      : reply.mode.kind === "off"
        ? "OUTPUTS_START_FAILED"
        : "OUTPUTS_REFUSED";
    const answer = result(code, ran ? null : reply.status.details);
    answer.outcome.applyStatus = reply.status;
    return answer;
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
    return { status: status("RETUNE_APPLIED", "Retuned") };
  },

  [LIGHTING_RUNTIME_COMMANDS.RELEASE_HUE_OUTPUT]: () => {
    mutate((w) => {
      w.hue.streaming = false;
      w.hue.stopped = true;
      const remaining = (w.lighting.mode.targets ?? []).filter((t) => t !== "hue");
      w.lighting.mode =
        remaining.length > 0
          ? { ...w.lighting.mode, targets: remaining }
          : { ...w.lighting.mode, kind: "off" };
    });
    return result("OUTPUTS_APPLIED");
  },

  [LIGHTING_RUNTIME_COMMANDS.GET_LIGHTING_RUNTIME]: () => snapshot(null),
} satisfies TypedHandlers;
