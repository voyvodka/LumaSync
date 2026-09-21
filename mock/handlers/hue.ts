/**
 * Hue fixtures.
 *
 * The distinctions this file exists to preserve are the ones the real app got
 * wrong and had to be fixed: an area that is genuinely empty, a bridge that
 * cannot be reached, and a key the bridge no longer accepts are three different
 * answers. They all used to arrive at the UI as "no lights".
 */

import { HUE_COMMANDS } from "../../src/shared/contracts/hue";
import { getWorld, mutate } from "../state";
import type { Handler } from "./types";

/** `HUE_AREA_CHANNELS_*` is the discriminator the panel branches on. */
function channelsStatus(): string {
  const { hue } = getWorld();
  if (!hue.reachable) return "HUE_AREA_CHANNELS_UNREACHABLE";
  if (!hue.credentialValid) return "HUE_CREDENTIAL_INVALID";
  return hue.channels.length > 0 ? "HUE_AREA_CHANNELS_OK" : "HUE_AREA_CHANNELS_EMPTY";
}

export const hueHandlers: Record<string, Handler> = {
  [HUE_COMMANDS.DISCOVER_BRIDGES]: () => {
    const { hue } = getWorld();
    return {
      status: { code: hue.bridges.length > 0 ? "HUE_DISCOVERY_OK" : "HUE_DISCOVERY_EMPTY" },
      bridges: hue.bridges.map((b) => ({ id: b.id, internalipaddress: b.ip, name: b.name })),
    };
  },

  [HUE_COMMANDS.VERIFY_BRIDGE_IP]: () => ({
    status: { code: getWorld().hue.reachable ? "HUE_IP_VALID" : "HUE_IP_UNREACHABLE" },
  }),

  [HUE_COMMANDS.PAIR_BRIDGE]: () => {
    const { hue } = getWorld();
    // The link-button wait is a countdown rather than a timer: the UI polls, and
    // the third poll is the one that succeeds. A scheduler would add a moving
    // part with nothing to show for it.
    if (hue.linkButtonPressesRemaining > 0) {
      mutate((w) => {
        w.hue.linkButtonPressesRemaining -= 1;
      });
      return { status: { code: "HUE_PAIRING_LINK_BUTTON_NOT_PRESSED" } };
    }
    mutate((w) => {
      w.hue.appKey = "mock-application-key";
      w.hue.credentialValid = true;
    });
    return {
      status: { code: "HUE_PAIRING_OK" },
      applicationKey: "mock-application-key",
      // Only the literal "keychain" licenses the app to drop its plaintext copy.
      credentialStorageBackend: "keychain",
    };
  },

  [HUE_COMMANDS.VALIDATE_CREDENTIALS]: () => {
    const { hue } = getWorld();
    if (hue.appKey === null) return { status: { code: "HUE_CREDENTIAL_INVALID" } };
    if (!hue.reachable) return { status: { code: "HUE_CREDENTIAL_CHECK_FAILED" } };
    return {
      status: { code: hue.credentialValid ? "HUE_CREDENTIAL_VALID" : "HUE_CREDENTIAL_INVALID" },
    };
  },

  [HUE_COMMANDS.LIST_ENTERTAINMENT_AREAS]: () => {
    const { hue } = getWorld();
    if (!hue.reachable) return { status: { code: "HUE_AREA_LIST_FAILED" }, areas: [] };
    return {
      status: { code: hue.areas.length > 0 ? "HUE_AREA_LIST_OK" : "HUE_AREA_LIST_EMPTY" },
      areas: hue.areas.map((a) => ({ id: a.id, name: a.name, channelCount: a.channelCount })),
    };
  },

  [HUE_COMMANDS.GET_AREA_CHANNELS]: () => {
    const { hue } = getWorld();
    return {
      status: { code: channelsStatus() },
      channels: hue.channels.map((c) => ({
        channelIndex: c.index,
        name: c.name,
        position: { x: 0, y: 0, z: 0 },
      })),
    };
  },

  [HUE_COMMANDS.CHECK_STREAM_READINESS]: () => {
    const { hue } = getWorld();
    if (!hue.reachable) return { status: { code: "HUE_IP_UNREACHABLE" } };
    if (!hue.credentialValid) return { status: { code: "HUE_CREDENTIAL_INVALID" } };
    return { status: { code: "HUE_STREAM_READY" } };
  },

  [HUE_COMMANDS.START_STREAM]: () => {
    const { hue } = getWorld();
    if (!hue.reachable) return { status: { code: "HUE_SENDER_INIT_FAILED" } };
    mutate((w) => {
      w.hue.streaming = true;
    });
    return { status: { code: "HUE_STREAM_STARTED" } };
  },

  [HUE_COMMANDS.STOP_STREAM]: () => {
    mutate((w) => {
      w.hue.streaming = false;
    });
    return { status: { code: "HUE_STREAM_STOPPED" } };
  },

  [HUE_COMMANDS.RESTART_STREAM]: () => ({ status: { code: "HUE_STREAM_STARTED" } }),

  [HUE_COMMANDS.GET_STREAM_STATUS]: () => {
    const { hue } = getWorld();
    return {
      status: { code: hue.streaming ? "HUE_STREAM_ACTIVE" : "HUE_STREAM_IDLE" },
      streaming: hue.streaming,
      packetsPerSecond: hue.streaming ? 20 : 0,
    };
  },

  [HUE_COMMANDS.SET_SOLID_COLOR]: () => {
    const { hue } = getWorld();
    if (hue.channels.length === 0) {
      return { status: { code: "HUE_COLOR_APPLY_SKIPPED_NO_LIGHTS" } };
    }
    return { status: { code: hue.streaming ? "HUE_COLOR_APPLIED" : "HUE_COLOR_QUEUED_PENDING_STREAM" } };
  },

  [HUE_COMMANDS.UPDATE_CHANNEL_POSITIONS]: () => ({
    status: { code: getWorld().hue.reachable ? "HUE_CHANNEL_POSITIONS_UPDATED" : "HUE_CHANNEL_POSITIONS_FAILED" },
  }),

  [HUE_COMMANDS.MIGRATE_CREDENTIALS]: () => ({
    status: { code: "HUE_CREDENTIAL_MIGRATION_SKIPPED" },
    credentialStorageBackend: "keychain",
  }),
};
