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
import { invokeCommand, type CommandInvoker } from "@/shared/ipcApi";

// Zone wrappers are pass-through on rejection — callers keep their existing
// `.catch(e => console.error(...))` diagnostics; absorbing the error here
// (previewApi's synthetic-fallback pattern) would erase per-site context.

/** Create a Hue zone. Wraps the payload under `request` — the shape the Rust handler expects. */
export async function createHueZone(
  payload: CreateHueZoneRequest,
  invoker: CommandInvoker = invokeCommand,
): Promise<HueZoneCommandResult> {
  return invoker(HUE_ZONE_COMMANDS.CREATE_HUE_ZONE, { request: payload });
}

/** Update a Hue zone (matched by `zone.id`). */
export async function updateHueZone(
  payload: UpdateHueZoneRequest,
  invoker: CommandInvoker = invokeCommand,
): Promise<HueZoneCommandResult> {
  return invoker(HUE_ZONE_COMMANDS.UPDATE_HUE_ZONE, { request: payload });
}

/** Delete a Hue zone; member channels detach to legacy absolute placement. */
export async function deleteHueZone(
  payload: DeleteHueZoneRequest,
  invoker: CommandInvoker = invokeCommand,
): Promise<HueZoneCommandResult> {
  return invoker(HUE_ZONE_COMMANDS.DELETE_HUE_ZONE, { request: payload });
}

/** Attach or detach a channel to/from a Hue zone (`zoneId: null` detaches). */
export async function assignChannelToHueZone(
  payload: AssignChannelRequest,
  invoker: CommandInvoker = invokeCommand,
): Promise<HueZoneCommandResult> {
  return invoker(HUE_ZONE_COMMANDS.ASSIGN_CHANNEL_TO_HUE_ZONE, { request: payload });
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
  invoker: CommandInvoker = invokeCommand,
): Promise<HueChannelWritebackStatus> {
  return invoker(HUE_COMMANDS.UPDATE_CHANNEL_POSITIONS, {
    channels: payload.channels,
    bridgeIp: payload.bridgeIp,
    username: payload.username,
    areaId: payload.areaId,
  });
}

/** Copy a user-picked image into the app data dir; returns the destination path. */
export async function copyBackgroundImage(
  srcPath: string,
  invoker: CommandInvoker = invokeCommand,
): Promise<string> {
  return invoker(ROOM_MAP_COMMANDS.COPY_BACKGROUND_IMAGE, { srcPath });
}
