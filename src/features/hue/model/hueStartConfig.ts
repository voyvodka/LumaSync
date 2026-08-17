// Shell-state → `startHue` projection plus the code predicates that read its
// answer. Together because every call site uses them in the same breath.

import {
  HUE_CREDENTIAL_BACKENDS,
  HUE_RUNTIME_STATUS,
  type HueChannelPlacementOverride,
  type HueCredentialBackend,
} from "@/shared/contracts/hue";
import type { RoomMapConfig } from "@/shared/contracts/roomMap";
import { hueChannelsForArea } from "@/shared/contracts/roomMap";
import {
  resolveHueChannelWorld,
} from "@/features/room-map/model/hueChannelPosition";

/** Bridge, credential and area selection required to open an entertainment stream. */
export interface HueStartConfig {
  bridgeIp: string;
  username: string;
  clientKey: string;
  areaId: string;
  /** The user's placements for the area. Derived here and nowhere else — the
   * region-override field this replaced was wired only on the Devices surface,
   * so it silently never rode the paths users actually start modes from. */
  channelPlacements?: HueChannelPlacementOverride[];
}

/** The area's placements as the wire shape: resolved to world space (a
 * zone-bound channel's authoritative position is zone-relative) and keyed by
 * the bridge's id. A record with no `channelId` is omitted, the same refusal
 * the write-back makes — never address the bridge by our ordinal. */
export function toChannelPlacements(
  roomMap: Pick<RoomMapConfig, "hueChannels" | "zones"> | undefined,
  areaId: string,
): HueChannelPlacementOverride[] | undefined {
  if (!roomMap) return undefined;
  const placements = hueChannelsForArea(roomMap.hueChannels ?? [], areaId)
    .filter((p) => p.channelId !== null && p.channelId !== undefined)
    .map((p) => {
      const world = resolveHueChannelWorld(p, roomMap.zones ?? []);
      return { channelId: p.channelId!, positionX: world.x, positionY: world.y };
    });
  return placements.length > 0 ? placements : undefined;
}

/** Returns `null` unless bridge, area and a pairing are all present. */
export function toHueStartConfig(state: {
  lastHueBridge?: { ip: string };
  hueAppKey?: string;
  hueClientKey?: string;
  credentialStorageBackend?: HueCredentialBackend;
  lastHueAreaId?: string;
  roomMap?: RoomMapConfig;
}): HueStartConfig | null {
  const bridgeIp = state.lastHueBridge?.ip?.trim();
  const username = state.hueAppKey?.trim() ?? "";
  const clientKey = state.hueClientKey?.trim() ?? "";
  const areaId = state.lastHueAreaId?.trim();
  // An empty app key is the keychain signal, so it can no longer stand in for
  // "never paired" — the backend field has to answer that instead.
  const paired =
    !!username || state.credentialStorageBackend === HUE_CREDENTIAL_BACKENDS.KEYCHAIN;
  if (!bridgeIp || !areaId || !paired) return null;
  return {
    bridgeIp,
    username,
    clientKey,
    areaId,
    channelPlacements: toChannelPlacements(state.roomMap, areaId),
  };
}

/** Stored blindly, a fresh object restarts every effect keyed on the config.
 * `channelPlacements` is excluded on purpose: comparing it would make each drag
 * an identity change and tear the DTLS stream down mid-edit. */
export function isSameHueStartConfig(
  a: HueStartConfig | null,
  b: HueStartConfig | null,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.bridgeIp === b.bridgeIp &&
    a.username === b.username &&
    a.clientKey === b.clientKey &&
    a.areaId === b.areaId
  );
}

/** All four codes that mean "the stream is up, or on its way up". */
export function isHueStartCodeOk(code: string): boolean {
  return (
    code === HUE_RUNTIME_STATUS.STREAM_RUNNING ||
    code === HUE_RUNTIME_STATUS.STREAM_RUNNING_DTLS ||
    code === HUE_RUNTIME_STATUS.STREAM_STARTING ||
    code === HUE_RUNTIME_STATUS.START_NOOP_ALREADY_ACTIVE
  );
}

/** Only a confirmed stop counts — anything else leaves the target active. */
export function isHueStopCodeOk(code: string): boolean {
  return code === HUE_RUNTIME_STATUS.STREAM_STOPPED;
}
