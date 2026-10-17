import {
  FIRST_ROOM_ID,
  ROOM_LAYOUTS_MAX,
  ROOM_NAME_MAX,
  type StoredRoomLayout,
  type StoredRoomLayouts,
} from "@/shared/contracts/roomLayouts";
import type { HueChannelPlacement, RoomMapConfig, UsbStripPlacement } from "@/shared/contracts/roomMap";

import { detachHueChannel } from "./hueChannelPosition";
import { cubeZones } from "./zoneCube";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export function roomName(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim().slice(0, ROOM_NAME_MAX);
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * The layouts as this build reads them, the active room first known by id. Absent or unreadable ⇒
 * the one implicit room. The active entry never keeps a config (`roomMap` is that room), an
 * inactive one without a readable config is dropped, a repeated id keeps its first entry, and the
 * list is cut to the limit with the active room kept.
 */
export function normalizeRoomLayouts(stored: unknown): StoredRoomLayouts {
  const implicit: StoredRoomLayouts = { activeId: FIRST_ROOM_ID, rooms: [{ id: FIRST_ROOM_ID }] };
  if (!isRecord(stored) || !Array.isArray(stored.rooms) || typeof stored.activeId !== "string") return implicit;
  const activeId = stored.activeId;
  const seen = new Set<string>();
  const rooms: StoredRoomLayout[] = [];
  for (const raw of stored.rooms) {
    if (!isRecord(raw) || typeof raw.id !== "string" || raw.id.length === 0 || seen.has(raw.id)) continue;
    const name = roomName(raw.name);
    const base: StoredRoomLayout = { id: raw.id, ...(name !== undefined ? { name } : {}) };
    if (raw.id === activeId) rooms.push(base);
    else if (isRecord(raw.config) && isRecord(raw.config.dimensions)) rooms.push({ ...base, config: raw.config as unknown as RoomMapConfig });
    else continue;
    seen.add(raw.id);
  }
  if (!seen.has(activeId)) rooms.unshift({ id: activeId });
  if (rooms.length <= ROOM_LAYOUTS_MAX) return { activeId, rooms };
  const kept = rooms.filter((room) => room.id !== activeId).slice(0, ROOM_LAYOUTS_MAX - 1);
  const at = rooms.findIndex((room) => room.id === activeId);
  kept.splice(Math.min(at, kept.length), 0, rooms[at]!);
  return { activeId, rooms: kept };
}

/** The other room's light with this one's identity, when it has it: by the bridge's channel id
 *  where both know it, else by the ordinal, within one entertainment area. */
function matchHueChannel(channel: HueChannelPlacement, candidates: readonly HueChannelPlacement[]): HueChannelPlacement | undefined {
  const area = channel.entertainmentAreaId ?? "";
  const sameArea = candidates.filter((other) => (other.entertainmentAreaId ?? "") === area);
  if (channel.channelId != null) {
    const byId = sameArea.find((other) => other.channelId === channel.channelId);
    if (byId) return byId;
  }
  return sameArea.find((other) => other.channelIndex === channel.channelIndex && (other.channelId == null || channel.channelId == null));
}

/** Room-owned fields of a light: where it stands and how it is drawn there. */
function placedAs(channel: HueChannelPlacement, placed: HueChannelPlacement): HueChannelPlacement {
  const next: HueChannelPlacement = { ...channel, x: placed.x, y: placed.y, z: placed.z };
  for (const key of ["zOrigin", "label", "locked", "zoneId", "zoneRelativePosition", "facing", "fixture"] as const) {
    if (placed[key] === undefined) delete next[key];
    else (next as unknown as Record<string, unknown>)[key] = placed[key];
  }
  return next;
}

/**
 * The room the lights move into: `target`'s layout over what the devices and the bridge own now.
 * - **Hue lights** are the current set (the bridge sync and the Hue page own which there are), each
 *   placed as `target` placed it when it knows the light, else left where it stands.
 * - **Zones** are `target`'s, their members renumbered onto the current lights.
 * - **Strips** linked to a port keep their id, port, LED count and density (the device's) and take
 *   `target`'s placement of that port, or stay where they are when it has none. `target`'s other
 *   strips are drawn ones: a port nothing is plugged into any more is dropped from them.
 * - **Everything else** — the room, its pieces, screen, structures, finish, images — is `target`'s.
 */
export function reconcileRoomSwitch(
  current: RoomMapConfig,
  target: RoomMapConfig,
  newStripId: () => string,
): RoomMapConfig {
  const targetChannels = target.hueChannels ?? [];
  const targetZones = target.zones ?? [];
  const currentZones = current.zones ?? [];
  const indexInCurrent = new Map<string, number>();
  const hueChannels = (current.hueChannels ?? []).map((channel) => {
    const placed = matchHueChannel(channel, targetChannels);
    if (!placed) return detachHueChannel(channel, currentZones);
    indexInCurrent.set(`${placed.entertainmentAreaId ?? ""}:${placed.channelIndex}`, channel.channelIndex);
    return placedAs(channel, placed);
  });
  const zones = targetZones.map((zone) => ({
    ...zone,
    channelIndices: zone.channelIndices.flatMap((index) => {
      const mapped = indexInCurrent.get(`${zone.entertainmentAreaId ?? ""}:${index}`);
      return mapped === undefined ? [] : [mapped];
    }),
  }));

  const linked = (current.usbStrips ?? []).filter((strip) => Boolean(strip.portName));
  const ports = new Set(linked.map((strip) => strip.portName));
  const stripIdInCurrent = new Map<string, string>();
  const carried: UsbStripPlacement[] = linked.map((strip) => {
    const placed = (target.usbStrips ?? []).find((other) => other.portName === strip.portName);
    if (!placed) return strip;
    stripIdInCurrent.set(placed.stripId, strip.stripId);
    const { stripId: _id, portName: _port, ledCount: _count, ledsPerMeter: _density, ...placement } = placed;
    return {
      ...placement,
      stripId: strip.stripId,
      portName: strip.portName,
      ledCount: strip.ledCount,
      ...(strip.ledsPerMeter !== undefined ? { ledsPerMeter: strip.ledsPerMeter } : {}),
    };
  });
  const taken = new Set(carried.map((strip) => strip.stripId));
  const drawn = (target.usbStrips ?? [])
    .filter((strip) => !(strip.portName && ports.has(strip.portName)))
    .map((strip) => {
      const { portName: _port, ...rest } = strip;
      const kept: UsbStripPlacement = strip.portName ? rest : strip;
      if (!taken.has(kept.stripId)) {
        taken.add(kept.stripId);
        return kept;
      }
      const id = newStripId();
      stripIdInCurrent.set(kept.stripId, id);
      taken.add(id);
      return { ...kept, stripId: id };
    });

  const tvAnchor = target.tvAnchor && typeof target.tvAnchor.backlightStripId === "string"
    ? { ...target.tvAnchor, backlightStripId: stripIdInCurrent.get(target.tvAnchor.backlightStripId) ?? target.tvAnchor.backlightStripId }
    : target.tvAnchor;

  // A kept room an older build wrote can hold zones that are not cubes.
  return cubeZones({ ...target, tvAnchor, usbStrips: [...carried, ...drawn], hueChannels, zones });
}

export interface RoomLayoutsWrite {
  roomMap: RoomMapConfig;
  roomLayouts: StoredRoomLayouts;
}

/** `current` is the stored active room, the file's and not the editor's. */
export function switchRoom(
  layouts: StoredRoomLayouts,
  current: RoomMapConfig,
  targetId: string,
  newStripId: () => string,
): RoomLayoutsWrite | null {
  const target = layouts.rooms.find((room) => room.id === targetId);
  if (!target?.config || targetId === layouts.activeId) return null;
  const roomMap = reconcileRoomSwitch(current, target.config, newStripId);
  const rooms = layouts.rooms.map((room) => {
    if (room.id === layouts.activeId) return { ...room, config: current };
    if (room.id === targetId) {
      const { config: _config, ...rest } = room;
      return rest;
    }
    return room;
  });
  return { roomMap, roomLayouts: { activeId: targetId, rooms } };
}

/** A new room after the others, made the active one. `config` is laid out over `current` by the caller. */
export function addRoom(
  layouts: StoredRoomLayouts,
  current: RoomMapConfig,
  room: { id: string; name?: string; config: RoomMapConfig },
): RoomLayoutsWrite | null {
  if (layouts.rooms.length >= ROOM_LAYOUTS_MAX || layouts.rooms.some((other) => other.id === room.id)) return null;
  const name = roomName(room.name);
  const rooms = [
    ...layouts.rooms.map((other) => (other.id === layouts.activeId ? { ...other, config: current } : other)),
    { id: room.id, ...(name !== undefined ? { name } : {}) },
  ];
  return { roomMap: room.config, roomLayouts: { activeId: room.id, rooms } };
}

export function renameRoom(layouts: StoredRoomLayouts, id: string, name: string): StoredRoomLayouts {
  const kept = roomName(name);
  return {
    ...layouts,
    rooms: layouts.rooms.map((room) => {
      if (room.id !== id) return room;
      const { name: _name, ...rest } = room;
      return kept === undefined ? rest : { ...rest, name: kept };
    }),
  };
}

/** Never the active room nor the last one: the lights always follow a room. */
export function deleteRoom(layouts: StoredRoomLayouts, id: string): StoredRoomLayouts | null {
  if (id === layouts.activeId || layouts.rooms.length <= 1 || !layouts.rooms.some((room) => room.id === id)) return null;
  return { ...layouts, rooms: layouts.rooms.filter((room) => room.id !== id) };
}
