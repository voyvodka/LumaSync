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
  HUE_AREA_CHANNELS_STATUS,
  HUE_COMMANDS,
  HUE_IDENTIFY_STATUS,
  HUE_LIGHT_NAMES_STATUS,
  HUE_READINESS_REASON,
  HUE_RUNTIME_STATES,
  HUE_RUNTIME_STATUS,
  HUE_RUNTIME_TRIGGER_SOURCE,
  HUE_STATUS,
} from "../../src/shared/contracts/hue";
import { CHANNEL_WRITEBACK_STATUS } from "../../src/shared/contracts/roomMap";
import type {
  HueRuntimeCommandResult,
  HueRuntimeState,
  HueRuntimeStatus,
  HueRuntimeWireStatusCode,
} from "../../src/shared/contracts/hue";
import { getWorld, mutate, type MockWorld } from "../state";
import { status } from "./status";
import type { TypedHandlers } from "./types";

const MOCK_BRIDGE_HEIGHTS: readonly number[] = [0.1, 0.1, 0.9];

/**
 * Bridge-fault verdict for the current world — reachability wins over an
 * invalid key, matching `register_transient_fault` / `register_auth_invalid`
 * in `src-tauri/src/commands/hue/{reconnect,retry}.rs`. `null` means neither
 * fault is active.
 *
 * An unreachable bridge is `Reconnecting` only once a stream has actually
 * gone live: `register_transient_fault` (`hue/retry.rs`) — the sole producer
 * of `Reconnecting` — is reachable only from the reconnect monitor and
 * `status_refresh_with_evidence`, both gated on
 * `Starting | Running | Reconnecting`. A start attempt against a runtime that
 * has never gone `Running` instead fails the strict gate in
 * `start_with_evidence`, which reports `Idle`/`CONFIG_NOT_READY_GATE_BLOCKED`
 * — never `Reconnecting`. `everActive` is the mock's proxy for "a stream was
 * live at some point this session" (see `MockWorld["hue"]["everActive"]`).
 * An expired key is terminal (`Failed`) regardless of `everActive`, matching
 * `start_with_evidence`'s own `auth_invalid_evidence` branch, which fails the
 * same way whether or not the runtime was ever running.
 *
 * After a stop there is no fault at all (`stopped`): `stop_with_timeout`
 * (`hue/retry.rs`) leaves the runtime Idle / `HUE_STREAM_STOPPED`, and a
 * fault here made the stop itself answer with a retry code, which the app
 * reads as a stop that failed.
 *
 * Shared with `device.ts`'s `get_runtime_telemetry` fixture so the stream
 * status poll and the telemetry HUD cannot disagree about the same world —
 * they used to: telemetry read only the `streaming` boolean and reported
 * "Idle" under both faults.
 */
export function hueRuntimeFault(
  hue: MockWorld["hue"],
): { code: HueRuntimeWireStatusCode; state: HueRuntimeState } | null {
  if (hue.stopped && !hue.streaming) return null;
  if (!hue.reachable) {
    return hue.everActive
      ? { code: HUE_RUNTIME_STATUS.TRANSIENT_RETRY_SCHEDULED, state: HUE_RUNTIME_STATES.RECONNECTING }
      : { code: HUE_RUNTIME_STATUS.CONFIG_NOT_READY_GATE_BLOCKED, state: HUE_RUNTIME_STATES.IDLE };
  }
  if (!hue.credentialValid) {
    return { code: HUE_RUNTIME_STATUS.AUTH_INVALID_CREDENTIALS, state: HUE_RUNTIME_STATES.FAILED };
  }
  return null;
}

/** Whether another session still holds the area, honouring a scheduled release. */
export function activeStreamerHeld(hue: MockWorld["hue"], now: number = Date.now()): boolean {
  if (!hue.activeStreamerElsewhere) return false;
  return hue.activeStreamerReleasesAt === null || now < hue.activeStreamerReleasesAt;
}

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
  const fault = hueRuntimeFault(hue);
  if (fault !== null) {
    // Keyed off the code, not the state, now that an unreachable bridge can
    // report either `Idle` (never started) or `Reconnecting` (was live) —
    // both mean "bridge unreachable", only the invalid-key branch differs.
    const message = fault.code === HUE_RUNTIME_STATUS.AUTH_INVALID_CREDENTIALS
      ? "Application key rejected"
      : "Bridge unreachable";
    return runtimeStatus(fault.code, fault.state, message);
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
    //
    // `HUE_PAIRING_LINK_BUTTON_NOT_PRESSED` is `pair_hue_bridge`'s real wire
    // code (`pairing_error_status` in `hue_onboarding.rs`, error.type 101).
    // `HUE_PAIRING_PENDING_LINK_BUTTON` is frontend-minted by
    // `useHueOnboardingCore`'s own poll translation and never appears on the
    // wire — returning it here shortcut that translation and left it
    // untested against the mock.
    if (hue.linkButtonPressesRemaining > 0) {
      mutate((w) => {
        w.hue.linkButtonPressesRemaining -= 1;
      });
      return {
        status: status(HUE_STATUS.PAIRING_LINK_BUTTON_NOT_PRESSED, "Press the link button"),
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

  // Its own three codes, distinct from the `HUE_IP_*` / `AUTH_INVALID_RE_PAIR_REQUIRED`
  // families other handlers use — the health monitor (`commands/hue/health.rs`)
  // keys off exactly `HUE_CREDENTIAL_VALID` for reachability and
  // `HUE_CREDENTIAL_CHECK_FAILED` for the give-up budget, matching
  // `validate_hue_credentials` in `hue_onboarding.rs`.
  [HUE_COMMANDS.VALIDATE_CREDENTIALS]: () => {
    const { hue } = getWorld();
    if (hue.appKey === null) {
      return {
        status: status(
          HUE_STATUS.CREDENTIAL_INVALID,
          "No stored Hue application key. Re-pair the bridge to continue.",
        ),
        valid: false,
      };
    }
    if (!hue.reachable) {
      return {
        status: status(
          HUE_STATUS.CREDENTIAL_CHECK_FAILED,
          "Could not validate Hue credentials. Check bridge reachability and retry.",
        ),
        valid: false,
      };
    }
    return hue.credentialValid
      ? { status: status(HUE_STATUS.CREDENTIAL_VALID, "Hue credentials are valid."), valid: true }
      : {
          status: status(
            HUE_STATUS.CREDENTIAL_INVALID,
            "Bridge rejected the stored application key. Re-pair required.",
          ),
          valid: false,
        };
  },

  /**
   * `list_hue_entertainment_areas` has no reachability branch of its own —
   * an unreachable bridge surfaces through `load_hue_entertainment_areas`'s
   * `AreaListError::Unreachable`, which collapses onto the same
   * `HUE_AREA_LIST_FAILED` as any other transport fault. `HUE_IP_UNREACHABLE`
   * is `verify_hue_bridge_ip`'s own code and this command never emits it; the
   * success code is `HUE_AREA_LIST_OK`, not discovery's `HUE_DISCOVERY_OK`.
   */
  [HUE_COMMANDS.LIST_ENTERTAINMENT_AREAS]: () => {
    const { hue } = getWorld();
    if (!hue.reachable) {
      return { status: status(HUE_STATUS.AREA_LIST_FAILED, "Could not reach bridge"), areas: [] };
    }
    if (!hue.credentialValid) {
      return {
        status: status(HUE_RUNTIME_STATUS.AUTH_INVALID_RE_PAIR_REQUIRED, "Key rejected"),
        areas: [],
      };
    }
    if (hue.areas.length === 0) {
      return { status: status(HUE_STATUS.AREA_LIST_EMPTY, "No entertainment areas"), areas: [] };
    }
    return {
      status: status(HUE_STATUS.AREA_LIST_OK, `${hue.areas.length} area(s)`),
      areas: hue.areas.map((a) => ({
        id: a.id,
        name: a.name,
        channelCount: a.channelCount,
        roomName: a.roomName,
        activeStreamer: a.activeStreamer,
      })),
    };
  },

  /**
   * `check_hue_stream_readiness` reads through the same
   * `load_hue_entertainment_areas` call as the area list, so it shares that
   * command's transport-failure code (`HUE_STREAM_READINESS_FAILED`, its own
   * family — not `HUE_IP_VALID`/`HUE_IP_UNREACHABLE`, which belong to
   * `verify_hue_bridge_ip`) and its auth-invalid code
   * (`AUTH_INVALID_RE_PAIR_REQUIRED`). Only a successfully-read area reaches
   * `HUE_STREAM_READY` / `HUE_STREAM_NOT_READY`.
   */
  [HUE_COMMANDS.CHECK_STREAM_READINESS]: () => {
    const { hue } = getWorld();
    if (!hue.reachable) {
      return {
        status: status(HUE_STATUS.STREAM_READINESS_FAILED, "Could not reach bridge"),
        readiness: { ready: false, reasons: ["Bridge unreachable"] },
      };
    }
    if (!hue.credentialValid) {
      return {
        status: status(HUE_RUNTIME_STATUS.AUTH_INVALID_RE_PAIR_REQUIRED, "Key rejected"),
        readiness: { ready: false, reasons: ["Application key rejected"] },
      };
    }
    const reasons: string[] = [];
    // The sentinel is compared against, never displayed — it is how the UI
    // tells "someone else owns the stream" from a generic refusal.
    if (activeStreamerHeld(hue)) reasons.push(HUE_READINESS_REASON.ACTIVE_STREAMER);
    return {
      status: status(
        reasons.length === 0 ? HUE_STATUS.STREAM_READY : HUE_STATUS.STREAM_NOT_READY,
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
        lastSolidColor: null,
        status: runtimeStatus(
          HUE_RUNTIME_STATUS.START_NOOP_ALREADY_ACTIVE,
          HUE_RUNTIME_STATES.RUNNING,
          "Already streaming",
        ),
      };
    }
    // A stopped runtime is Idle, so an unreachable bridge fails the strict
    // gate, as on a fresh launch; only a key the bridge rejects moves it (to Failed).
    if (hue.stopped && !hue.reachable) {
      return {
        active: false,
        lastSolidColor: null,
        status: runtimeStatus(
          HUE_RUNTIME_STATUS.CONFIG_NOT_READY_GATE_BLOCKED,
          HUE_RUNTIME_STATES.IDLE,
          "Hue stream start blocked by strict backend readiness gate.",
        ),
      };
    }
    if (!hue.credentialValid) {
      mutate((w) => {
        w.hue.stopped = false;
      });
    }
    if (!hue.reachable || !hue.credentialValid) {
      return { active: false, status: currentRuntime(), lastSolidColor: null };
    }
    // `start_with_evidence` fails its strict gate on a held area with the same
    // `details` shape Rust builds (see `CONFIG_NOT_READY_GATE_BLOCKED` in
    // hue.ts), so a consumer reads the mock exactly as it reads Rust.
    if (activeStreamerHeld(hue)) {
      return {
        active: false,
        lastSolidColor: null,
        status: {
          ...runtimeStatus(
            HUE_RUNTIME_STATUS.CONFIG_NOT_READY_GATE_BLOCKED,
            HUE_RUNTIME_STATES.IDLE,
            "Hue stream start blocked by strict backend readiness gate.",
          ),
          details: `Missing prerequisites: ready; readiness: ${HUE_STATUS.STREAM_NOT_READY}, ${HUE_READINESS_REASON.ACTIVE_STREAMER}`,
        },
      };
    }
    mutate((w) => {
      w.hue.streaming = true;
      w.hue.everActive = true;
      w.hue.stopped = false;
    });
    return { active: true, status: currentRuntime(), lastSolidColor: null };
  },

  [HUE_COMMANDS.RESTART_STREAM]: () => {
    mutate((w) => {
      w.hue.stopped = false;
      w.hue.streaming = w.hue.reachable && w.hue.credentialValid;
      if (w.hue.streaming) {
        w.hue.everActive = true;
        w.hue.totalReconnects += 1;
      }
    });
    return { active: getWorld().hue.streaming, status: currentRuntime(), lastSolidColor: null };
  },

  [HUE_COMMANDS.GET_STREAM_STATUS]: () => ({
    active: getWorld().hue.streaming,
    status: currentRuntime(),
    lastSolidColor: null,
  }),

  /**
   * `index` and `channelId` are different numbers and the difference matters:
   * ours is the local ordinal, the bridge's is its own identity, and they
   * agree only on a contiguous area. Addressing a light by the wrong one is a
   * bug this app has already shipped once.
   */
  [HUE_COMMANDS.GET_AREA_CHANNELS]: () => {
    const { hue } = getWorld();
    // This family carries its own three codes. Unreachable, empty and
    // key-rejected are three different answers, and collapsing any two of them
    // is the bug this scenario set exists to keep reproducible.
    if (!hue.reachable) {
      return {
        status: status(HUE_AREA_CHANNELS_STATUS.UNREACHABLE, "Bridge unreachable"),
        channels: [],
      };
    }
    if (!hue.credentialValid) {
      return {
        status: status(HUE_RUNTIME_STATUS.AUTH_INVALID_RE_PAIR_REQUIRED, "Key rejected"),
        channels: [],
      };
    }
    return {
      status: status(
        hue.channels.length > 0 ? HUE_AREA_CHANNELS_STATUS.OK : HUE_AREA_CHANNELS_STATUS.EMPTY,
        `${hue.channels.length} channel(s)`,
      ),
      channels: hue.channels.map((c, ordinal) => ({
        index: ordinal,
        channelId: c.index,
        lightIds: [`light-${c.index}`],
        positionX: c.stored?.x ?? 0,
        positionY: c.stored?.y ?? 0,
        // Matches the heights in `mock/roomMaps.ts`; the lamp's is left
        // unreported so the "bridge sent no z" path is reachable too.
        positionZ: c.stored ? c.stored.z : (MOCK_BRIDGE_HEIGHTS[c.index] ?? null),
        lightCount: 1,
        autoRegion: "none",
      })),
    };
  },

  // Stores what it is sent, so the channel map's re-read after a save finds it.
  [HUE_COMMANDS.UPDATE_CHANNEL_POSITIONS]: ({ channels }) => {
    const { hue } = getWorld();
    if (!hue.reachable) {
      return status(CHANNEL_WRITEBACK_STATUS.NETWORK_ERROR, "Could not reach the bridge");
    }
    if (!hue.credentialValid) {
      return status(HUE_RUNTIME_STATUS.AUTH_INVALID_RE_PAIR_REQUIRED, "Key rejected");
    }
    mutate((w) => {
      for (const placement of channels) {
        const target = w.hue.channels.find((c) => c.index === placement.channelId);
        if (!target) continue;
        // A height of unknown origin keeps the bridge's own, as `merge_service_locations` does.
        const keptZ = target.stored ? target.stored.z : (MOCK_BRIDGE_HEIGHTS[target.index] ?? null);
        target.stored = { x: placement.x, y: placement.y, z: placement.zOrigin ? placement.z : keptZ };
      }
    });
    return status(HUE_RUNTIME_STATUS.CHANNEL_POSITIONS_UPDATED, "Saved to bridge");
  },

  /**
   * Only the literal `"keychain"` licenses the app to delete its plaintext
   * copy of the key, so this fixture is a write as much as a read.
   */
  [HUE_COMMANDS.MIGRATE_CREDENTIALS]: () => ({
    status: status(HUE_STATUS.PAIRING_OK, "Nothing to migrate"),
    backend: "keychain" as const,
  }),

  /** Each light is named after its channel, as `get_hue_area_channels` ids them. */
  [HUE_COMMANDS.GET_LIGHT_NAMES]: ({ lightIds }) => {
    const { hue } = getWorld();
    if (!hue.reachable) {
      return { status: status(HUE_LIGHT_NAMES_STATUS.FAILED, "Bridge unreachable"), lights: [] };
    }
    if (!hue.credentialValid) {
      return { status: status(HUE_RUNTIME_STATUS.AUTH_INVALID_RE_PAIR_REQUIRED, "Key rejected"), lights: [] };
    }
    const lights = lightIds.flatMap((id) => {
      const channel = hue.channels.find((c) => `light-${c.index}` === id);
      return channel ? [{ id, name: channel.name }] : [];
    });
    return { status: status(HUE_LIGHT_NAMES_STATUS.OK, "Hue light names loaded."), lights };
  },

  [HUE_COMMANDS.IDENTIFY_LIGHTS]: () => {
    const { hue } = getWorld();
    if (hue.streaming) {
      return status(HUE_IDENTIFY_STATUS.BLOCKED_STREAMING, "Hue is streaming to these lights.");
    }
    if (!hue.reachable) return status(HUE_IDENTIFY_STATUS.FAILED, "No Hue light was identified.", "Bridge unreachable");
    if (!hue.credentialValid) return status(HUE_RUNTIME_STATUS.AUTH_INVALID_RE_PAIR_REQUIRED, "Key rejected");
    return status(HUE_IDENTIFY_STATUS.OK, "The light blinks once.");
  },

  [HUE_COMMANDS.SET_SOLID_COLOR]: () => {
    const { hue } = getWorld();
    if (hue.channels.length === 0) {
      return {
        active: hue.streaming,
        lastSolidColor: null,
        status: runtimeStatus(
          HUE_RUNTIME_STATUS.CONFIG_NOT_READY_GATE_BLOCKED,
          HUE_RUNTIME_STATES.IDLE,
          "No lights in the area",
        ),
      };
    }
    return { active: hue.streaming, status: currentRuntime(), lastSolidColor: null };
  },
} satisfies TypedHandlers;

/**
 * The lighting transaction's Hue stop (`stop_hue_stream_on` in Rust; no
 * command reaches it on its own). Local in Rust: the stop answers
 * `HUE_STREAM_STOPPED` whatever the bridge is doing, so it never reads as a
 * failed stop that leaves Hue listed active.
 */
export function stopHueStream(): HueRuntimeCommandResult {
  mutate((w) => {
    w.hue.streaming = false;
    w.hue.stopped = true;
  });
  return { active: false, status: currentRuntime(), lastSolidColor: null };
}
