import { invoke } from "@tauri-apps/api/core";

import { HUE_COMMANDS, type HueChannelWritebackStatus } from "@/shared/contracts/hue";
import {
  HUE_ZONE_COMMANDS,
  ROOM_MAP_COMMANDS,
  type AssignChannelRequest,
  type CreateHueZoneRequest,
  type DeleteHueZoneRequest,
  type HueChannelPlacement,
  type HueZoneCommandResult,
  type UpdateHueZoneRequest,
} from "@/shared/contracts/roomMap";

export type RoomMapInvoker = <T>(command: string, payload?: Record<string, unknown>) => Promise<T>;

const defaultInvoke: RoomMapInvoker = (command, payload) => invoke(command, payload);

// Zone wrappers are pass-through on rejection — callers keep their existing
// `.catch(e => console.error(...))` diagnostics; absorbing the error here
// (previewApi's synthetic-fallback pattern) would erase per-site context.

/** Create a Hue zone. Wraps the payload under `request` — the shape the Rust handler expects. */
export async function createHueZone(
  payload: CreateHueZoneRequest,
  invoker: RoomMapInvoker = defaultInvoke,
): Promise<HueZoneCommandResult> {
  return invoker<HueZoneCommandResult>(HUE_ZONE_COMMANDS.CREATE_HUE_ZONE, { request: payload });
}

/** Update a Hue zone (matched by `zone.id`). */
export async function updateHueZone(
  payload: UpdateHueZoneRequest,
  invoker: RoomMapInvoker = defaultInvoke,
): Promise<HueZoneCommandResult> {
  return invoker<HueZoneCommandResult>(HUE_ZONE_COMMANDS.UPDATE_HUE_ZONE, { request: payload });
}

/** Delete a Hue zone; member channels detach to legacy absolute placement. */
export async function deleteHueZone(
  payload: DeleteHueZoneRequest,
  invoker: RoomMapInvoker = defaultInvoke,
): Promise<HueZoneCommandResult> {
  return invoker<HueZoneCommandResult>(HUE_ZONE_COMMANDS.DELETE_HUE_ZONE, { request: payload });
}

/** Attach or detach a channel to/from a Hue zone (`zoneId: null` detaches). */
export async function assignChannelToHueZone(
  payload: AssignChannelRequest,
  invoker: RoomMapInvoker = defaultInvoke,
): Promise<HueZoneCommandResult> {
  return invoker<HueZoneCommandResult>(HUE_ZONE_COMMANDS.ASSIGN_CHANNEL_TO_HUE_ZONE, { request: payload });
}

export interface UpdateHueChannelPositionsPayload {
  channels: HueChannelPlacement[];
  bridgeIp: string;
  username: string;
  areaId: string;
}

/** Write channel positions back to the bridge. Flat args — `save_load.rs` takes four positional params, not an envelope. */
export async function updateHueChannelPositions(
  payload: UpdateHueChannelPositionsPayload,
  invoker: RoomMapInvoker = defaultInvoke,
): Promise<HueChannelWritebackStatus> {
  return invoker<HueChannelWritebackStatus>(HUE_COMMANDS.UPDATE_CHANNEL_POSITIONS, {
    channels: payload.channels,
    bridgeIp: payload.bridgeIp,
    username: payload.username,
    areaId: payload.areaId,
  });
}

/** Copy a user-picked image into the app data dir; returns the destination path. */
export async function copyBackgroundImage(
  srcPath: string,
  invoker: RoomMapInvoker = defaultInvoke,
): Promise<string> {
  return invoker<string>(ROOM_MAP_COMMANDS.COPY_BACKGROUND_IMAGE, { srcPath });
}
