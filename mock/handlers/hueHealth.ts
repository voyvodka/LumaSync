/**
 * The Rust health monitor, in small: one snapshot derived from the world, the
 * same answers the other Hue fixtures give, and a `hue://health` event on
 * every world change once a window has asked. The real monitor decides what
 * to read and when; the mock has nothing to read, so it just re-derives.
 */

import { HUE_COMMANDS, HUE_RUNTIME_STATES, type HueRuntimeStatus } from "../../src/shared/contracts/hue";
import {
  HUE_BRIDGE_VERDICT,
  HUE_EVENTS,
  HUE_HEALTH_COMMANDS,
  type HueBridgeVerdict,
  type HueHealthSnapshot,
} from "../../src/shared/contracts/hueHealth";
import type { HueStreamReadinessResponse } from "../../src/features/hue/hueOnboardingApi";
import { emitMockEvent } from "../events";
import { getWorld, subscribe } from "../state";
import { hueHandlers } from "./hue";
import type { TypedHandlers } from "./types";

let revision = 0;
let publishing = false;
let last = "";

function verdict(): HueBridgeVerdict | null {
  const { hue } = getWorld();
  if (hue.appKey === null) return null;
  if (!hue.reachable) return HUE_BRIDGE_VERDICT.UNREACHABLE;
  return hue.credentialValid ? HUE_BRIDGE_VERDICT.REACHABLE : HUE_BRIDGE_VERDICT.CREDENTIAL_REJECTED;
}

function snapshot(): Omit<HueHealthSnapshot, "revision"> {
  const { hue } = getWorld();
  const configured = hue.appKey !== null && hue.selectedAreaId !== null;
  const stream = hueHandlers[HUE_COMMANDS.GET_STREAM_STATUS]();
  const readiness = configured
    ? (hueHandlers[HUE_COMMANDS.CHECK_STREAM_READINESS]() as HueStreamReadinessResponse)
    : null;
  return {
    configured,
    bridge: { verdict: configured ? verdict() : null, probing: false, gaveUp: false },
    area:
      configured && readiness && hue.selectedAreaId
        ? {
            areaId: hue.selectedAreaId,
            status: readiness.status,
            readiness: readiness.readiness,
            checkedAtMs: Date.now(),
          }
        : null,
    stream: {
      active: stream.status.state !== HUE_RUNTIME_STATES.IDLE && stream.status.state !== HUE_RUNTIME_STATES.FAILED,
      status: stream.status satisfies HueRuntimeStatus,
    },
  };
}

/** A new revision only when something other than the read time moved. */
function current(): HueHealthSnapshot {
  const next = snapshot();
  const key = JSON.stringify({ ...next, area: next.area ? { ...next.area, checkedAtMs: 0 } : null });
  if (key !== last) {
    last = key;
    revision += 1;
  }
  return { ...next, revision };
}

function startPublishing(): void {
  if (publishing) return;
  publishing = true;
  subscribe(() => {
    const before = revision;
    const next = current();
    if (next.revision !== before) void emitMockEvent(HUE_EVENTS.HEALTH_CHANGED, next);
  });
}

export const hueHealthHandlers = {
  [HUE_HEALTH_COMMANDS.GET_HUE_HEALTH]: () => current(),
  [HUE_HEALTH_COMMANDS.WATCH_HUE_HEALTH]: () => {
    startPublishing();
    return current();
  },
  [HUE_HEALTH_COMMANDS.RETRY_HUE_HEALTH]: () => current(),
} satisfies TypedHandlers;
