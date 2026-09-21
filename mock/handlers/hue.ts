/**
 * Hue fixtures.
 *
 * The distinctions this file exists to preserve are the ones the real app got
 * wrong and had to be fixed: an area that is genuinely empty, a bridge that
 * cannot be reached, and a key the bridge no longer accepts are three
 * different answers. They all used to arrive at the UI as "no lights".
 *
 * The first version of this file invented `HUE_STREAM_STARTED` and
 * `HUE_STREAM_ACTIVE`, neither of which exists in the contract, and returned a
 * bare `streaming` boolean where the app expects a `HueRuntimeStatus` carrying
 * `state` and `triggerSource`. The runtime poll loop keys off that `state`, so
 * the entire polling path was dead in the mock and nothing said so. Everything
 * here is now checked against the real response types.
 */

import {
  HUE_COMMANDS,
  HUE_RUNTIME_STATES,
  HUE_RUNTIME_STATUS,
  HUE_RUNTIME_TRIGGER_SOURCE,
  HUE_STATUS,
} from "../../src/shared/contracts/hue";
import type { HueRuntimeStatus } from "../../src/shared/contracts/hue";
import { getWorld, mutate } from "../state";
import { status } from "./status";
import type { TypedHandlers } from "./types";

/** The runtime envelope, which is a status *plus* a state machine position. */
function runtimeStatus(
  code: HueRuntimeStatus["code"],
  state: HueRuntimeStatus["state"],
  message: string,
): HueRuntimeStatus {
  return {
    ...status(code, message),
    state,
    triggerSource: HUE_RUNTIME_TRIGGER_SOURCE.MODE_CONTROL,
  };
}

function currentRuntime(): HueRuntimeStatus {
  const { hue } = getWorld();
  if (!hue.reachable) {
    return runtimeStatus(
      HUE_RUNTIME_STATUS.TRANSIENT_RETRY_SCHEDULED,
      HUE_RUNTIME_STATES.RECONNECTING,
      "Bridge unreachable",
    );
  }
  if (!hue.credentialValid) {
    return runtimeStatus(
      HUE_RUNTIME_STATUS.AUTH_INVALID_CREDENTIALS,
      HUE_RUNTIME_STATES.FAILED,
      "Application key rejected",
    );
  }
  return hue.streaming
    ? runtimeStatus(
        HUE_RUNTIME_STATUS.STREAM_RUNNING_DTLS,
        HUE_RUNTIME_STATES.RUNNING,
        "Streaming",
      )
    : runtimeStatus(HUE_RUNTIME_STATUS.STREAM_STOPPED, HUE_RUNTIME_STATES.IDLE, "Idle");
}

export const hueHandlers = {
  [HUE_COMMANDS.DISCOVER_BRIDGES]: () => {
    const { hue } = getWorld();
    return {
      status: status(
        hue.bridges.length > 0 ? HUE_STATUS.DISCOVERY_OK : HUE_STATUS.DISCOVERY_EMPTY,
        `${hue.bridges.length} bridge(s)`,
      ),
      // `HueBridgeSummary.ip`, not `internalipaddress` — the cloud endpoint's
      // spelling never reaches the frontend, and using it sent `undefined`
      // through as the bridge address.
      bridges: hue.bridges.map((b) => ({ id: b.id, ip: b.ip, name: b.name })),
    };
  },

  [HUE_COMMANDS.VERIFY_BRIDGE_IP]: () => {
    const { hue } = getWorld();
    const bridge = hue.bridges[0];
    if (!hue.reachable || bridge === undefined) {
      return { status: status(HUE_STATUS.IP_UNREACHABLE, "No answer"), bridge: null };
    }
    return {
      status: status(HUE_STATUS.IP_VALID, "Bridge answered"),
      bridge: { id: bridge.id, ip: bridge.ip, name: bridge.name },
    };
  },

  [HUE_COMMANDS.PAIR_BRIDGE]: () => {
    const { hue } = getWorld();
    // The link-button wait is a countdown rather than a timer: the UI polls,
    // and the nth poll is the one that succeeds. A scheduler would add a
    // moving part with nothing to show for it.
    if (hue.linkButtonPressesRemaining > 0) {
      mutate((w) => {
        w.hue.linkButtonPressesRemaining -= 1;
      });
      return {
        status: status(HUE_STATUS.PAIRING_PENDING_LINK_BUTTON, "Press the link button"),
        credentials: null,
      };
    }
    mutate((w) => {
      w.hue.appKey = "mock-application-key";
      w.hue.credentialValid = true;
    });
    return {
      status: status(HUE_STATUS.PAIRING_OK, "Paired"),
      // Both halves are required: without `clientKey` there is no PSK, so the
      // stream can never start and pairing "succeeds" into a dead end.
      credentials: { username: "mock-application-key", clientKey: "6d6f636b636c69656e746b6579" },
    };
  },

  [HUE_COMMANDS.VALIDATE_CREDENTIALS]: () => {
    const { hue } = getWorld();
    if (hue.appKey === null) {
      return {
        status: status(HUE_RUNTIME_STATUS.AUTH_INVALID_RE_PAIR_REQUIRED, "Never paired"),
        valid: false,
      };
    }
    if (!hue.reachable) {
      return { status: status(HUE_STATUS.IP_UNREACHABLE, "No answer"), valid: false };
    }
    return hue.credentialValid
      ? { status: status(HUE_STATUS.IP_VALID, "Key accepted"), valid: true }
      : {
          status: status(HUE_RUNTIME_STATUS.AUTH_INVALID_RE_PAIR_REQUIRED, "Key rejected"),
          valid: false,
        };
  },

  [HUE_COMMANDS.LIST_ENTERTAINMENT_AREAS]: () => {
    const { hue } = getWorld();
    if (!hue.reachable) {
      return { status: status(HUE_STATUS.IP_UNREACHABLE, "No answer"), areas: [] };
    }
    if (!hue.credentialValid) {
      return {
        status: status(HUE_RUNTIME_STATUS.AUTH_INVALID_RE_PAIR_REQUIRED, "Key rejected"),
        areas: [],
      };
    }
    return {
      status: status(HUE_STATUS.DISCOVERY_OK, `${hue.areas.length} area(s)`),
      areas: hue.areas.map((a) => ({
        id: a.id,
        name: a.name,
        channelCount: a.channelCount,
        roomName: a.roomName,
        activeStreamer: a.activeStreamer,
      })),
    };
  },

  [HUE_COMMANDS.CHECK_STREAM_READINESS]: () => {
    const { hue } = getWorld();
    const reasons: string[] = [];
    if (!hue.reachable) reasons.push("Bridge unreachable");
    if (!hue.credentialValid) reasons.push("Application key rejected");
    // The sentinel is compared against, never displayed — it is how the UI
    // tells "someone else owns the stream" from a generic refusal.
    if (hue.activeStreamerElsewhere) reasons.push("HUE_STREAM_NOT_READY_ACTIVE_STREAMER");
    return {
      status: status(
        reasons.length === 0 ? HUE_STATUS.IP_VALID : HUE_STATUS.IP_UNREACHABLE,
        "Readiness",
      ),
      readiness: { ready: reasons.length === 0, reasons },
    };
  },

  [HUE_COMMANDS.START_STREAM]: () => {
    const { hue } = getWorld();
    if (hue.streaming) {
      return {
        active: true,
        status: runtimeStatus(
          HUE_RUNTIME_STATUS.START_NOOP_ALREADY_ACTIVE,
          HUE_RUNTIME_STATES.RUNNING,
          "Already streaming",
        ),
      };
    }
    if (!hue.reachable || !hue.credentialValid) {
      return { active: false, status: currentRuntime() };
    }
    mutate((w) => {
      w.hue.streaming = true;
      w.hue.everActive = true;
    });
    return { active: true, status: currentRuntime() };
  },

  [HUE_COMMANDS.STOP_STREAM]: () => {
    mutate((w) => {
      w.hue.streaming = false;
    });
    return { active: false, status: currentRuntime() };
  },

  [HUE_COMMANDS.RESTART_STREAM]: () => {
    mutate((w) => {
      w.hue.streaming = w.hue.reachable && w.hue.credentialValid;
      if (w.hue.streaming) {
        w.hue.everActive = true;
        w.hue.totalReconnects += 1;
      }
    });
    return { active: getWorld().hue.streaming, status: currentRuntime() };
  },

  [HUE_COMMANDS.GET_STREAM_STATUS]: () => ({
    active: getWorld().hue.streaming,
    status: currentRuntime(),
  }),

  [HUE_COMMANDS.SET_SOLID_COLOR]: () => {
    const { hue } = getWorld();
    if (hue.channels.length === 0) {
      return {
        active: hue.streaming,
        status: runtimeStatus(
          HUE_RUNTIME_STATUS.CONFIG_NOT_READY_GATE_BLOCKED,
          HUE_RUNTIME_STATES.IDLE,
          "No lights in the area",
        ),
      };
    }
    return { active: hue.streaming, status: currentRuntime() };
  },
} satisfies TypedHandlers;
