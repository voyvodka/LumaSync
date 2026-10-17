import type { HueChannelPlacement, RoomMapConfig } from "@/shared/contracts/roomMap";
import { findHueChannel, replaceHueChannel, translateStrip } from "@/shared/contracts/roomMap";

import { moveTvWithBacklight } from "./backlight";
import { moveHueChannelToWorld, nudgeHueChannel } from "./hueChannelPosition";
import { seatMovedLight } from "./lightSeat";
import { findScopedHueChannel, updateScopedHueChannel } from "./hueChannelScope";
import { furnitureObjectId, usbStripObjectId, type RoomObjectKind, type RoomObjectRef } from "./objectId";
import { keepPlacedInside, keepStripInside, roomBoxOf } from "./pieceGeometry";
import type { InspectorTarget } from "./resolveInspectorTarget";

type Patch = Partial<RoomMapConfig>;

export interface RoomObjectContext {
  /** The entertainment area on screen; Hue channel ids resolve inside it. */
  hueAreaId: string | null;
}

/** An arrow key as a direction on screen: x right, y down. */
export interface NudgeDirection {
  x: -1 | 0 | 1;
  y: -1 | 0 | 1;
  /** Shift held: a metre instead of ten centimetres. */
  coarse: boolean;
}

/** One kind's answers to everything the editor does to an object. `null` means the kind cannot. */
export interface RoomObjectAdapter<K extends RoomObjectKind> {
  /** Still in the config — undo can take the selected object away. */
  exists: (config: RoomMapConfig, ref: RoomObjectRef<K>) => boolean;
  isLocked: (config: RoomMapConfig, ref: RoomObjectRef<K>, ctx: RoomObjectContext) => boolean;
  toggleLock: (
    config: RoomMapConfig,
    ref: RoomObjectRef<K>,
    visibleHueChannels: readonly HueChannelPlacement[],
  ) => Patch | null;
  remove: ((config: RoomMapConfig, ref: RoomObjectRef<K>) => Patch) | null;
  duplicate:
    | ((config: RoomMapConfig, ref: RoomObjectRef<K>, offset: number) => { patch: Patch; objectId: string } | null)
    | null;
  moveTo: (config: RoomMapConfig, ref: RoomObjectRef<K>, x: number, y: number, ctx: RoomObjectContext) => Patch | null;
  /** Reads the newest config: a held arrow applies many of these in a row. */
  nudge: ((config: RoomMapConfig, ref: RoomObjectRef<K>, direction: NudgeDirection, ctx: RoomObjectContext) => Patch) | null;
  rotateBy: ((config: RoomMapConfig, ref: RoomObjectRef<K>, degrees: number) => Patch) | null;
  /** A new name, from the inspector's name field. */
  rename: ((config: RoomMapConfig, ref: RoomObjectRef<K>, label: string, ctx: RoomObjectContext) => Patch) | null;
  inspect: (config: RoomMapConfig, ref: RoomObjectRef<K>) => InspectorTarget | null;
}

/** The TV at (`x`, `y`) inside the walls, its backlight carried as a drag carries it. */
function tvMovedTo(config: RoomMapConfig, x: number, y: number): Patch {
  const tv = config.tvAnchor!;
  const room = roomBoxOf(config);
  const tvAnchor = keepPlacedInside({ ...tv, x, y }, room);
  const usbStrips = moveTvWithBacklight(config.usbStrips, tv, tvAnchor, (s) => keepStripInside(s, room));
  return usbStrips ? { tvAnchor, usbStrips } : { tvAnchor };
}

const worldStep = ({ x, y, coarse }: NudgeDirection) => {
  const metres = coarse ? 1.0 : 0.1;
  return { dx: x * metres, dy: y * metres };
};

/** Hue channels live in [-1, 1] with y towards the front, so screen-up is +y. */
const HUE_NUDGE_STEP = 0.05;

/**
 * Every room-map object kind, one row each. A new kind fails to compile here
 * until each of the editor's operations has an answer for it.
 */
export const ROOM_OBJECT_KINDS = {
  tv: {
    exists: (config) => config.tvAnchor !== undefined,
    isLocked: (config) => !!config.tvAnchor?.locked,
    toggleLock: (config) =>
      config.tvAnchor ? { tvAnchor: { ...config.tvAnchor, locked: !config.tvAnchor.locked } } : null,
    remove: () => ({ tvAnchor: undefined }),
    duplicate: null,
    moveTo: (config, _ref, x, y) => (config.tvAnchor ? tvMovedTo(config, x, y) : null),
    nudge: (cfg, _ref, direction) => {
      const { dx, dy } = worldStep(direction);
      return cfg.tvAnchor ? tvMovedTo(cfg, cfg.tvAnchor.x + dx, cfg.tvAnchor.y + dy) : {};
    },
    rotateBy: null,
    rename: null,
    inspect: (config) => (config.tvAnchor ? { kind: "tv", tv: config.tvAnchor } : null),
  },
  furniture: {
    exists: (config, ref) => config.furniture.some((f) => f.id === ref.furnitureId),
    isLocked: (config, ref) => !!config.furniture.find((f) => f.id === ref.furnitureId)?.locked,
    toggleLock: (config, ref) => ({
      furniture: config.furniture.map((f) => (f.id === ref.furnitureId ? { ...f, locked: !f.locked } : f)),
    }),
    remove: (config, ref) => ({ furniture: config.furniture.filter((f) => f.id !== ref.furnitureId) }),
    duplicate: (config, ref, offset) => {
      const src = config.furniture.find((f) => f.id === ref.furnitureId);
      if (!src) return null;
      const dup = { ...src, id: crypto.randomUUID(), x: src.x + offset, y: src.y + offset };
      return { patch: { furniture: [...config.furniture, dup] }, objectId: furnitureObjectId(dup.id) };
    },
    moveTo: (config, ref, x, y) => ({
      furniture: config.furniture.map((f) => (f.id === ref.furnitureId ? keepPlacedInside({ ...f, x, y }, roomBoxOf(config)) : f)),
    }),
    nudge: (cfg, ref, direction) => {
      const { dx, dy } = worldStep(direction);
      return {
        furniture: cfg.furniture.map((f) =>
          f.id === ref.furnitureId ? keepPlacedInside({ ...f, x: f.x + dx, y: f.y + dy }, roomBoxOf(cfg)) : f,
        ),
      };
    },
    rotateBy: (config, ref, degrees) => ({
      furniture: config.furniture.map((f) =>
        f.id === ref.furnitureId ? { ...f, rotation: ((f.rotation ?? 0) + degrees) % 360 } : f,
      ),
    }),
    rename: (config, ref, label) => ({
      furniture: config.furniture.map((f) => (f.id === ref.furnitureId ? { ...f, label } : f)),
    }),
    inspect: (config, ref) => {
      const item = config.furniture.find((f) => f.id === ref.furnitureId);
      return item ? { kind: "furniture", item } : null;
    },
  },
  usb: {
    exists: (config, ref) => config.usbStrips.some((s) => s.stripId === ref.stripId),
    isLocked: (config, ref) => !!config.usbStrips.find((s) => s.stripId === ref.stripId)?.locked,
    toggleLock: (config, ref) => ({
      usbStrips: config.usbStrips.map((s) => (s.stripId === ref.stripId ? { ...s, locked: !s.locked } : s)),
    }),
    remove: (config, ref) => ({
      usbStrips: config.usbStrips.filter((s) => s.stripId !== ref.stripId),
      ...(config.tvAnchor?.backlightStripId === ref.stripId ? { tvAnchor: { ...config.tvAnchor, backlightStripId: undefined } } : {}),
    }),
    duplicate: (config, ref, offset) => {
      const src = config.usbStrips.find((s) => s.stripId === ref.stripId);
      if (!src) return null;
      // A copy is a drawn strip: one port drives one tape, and the original keeps it.
      const { portName: _port, ...drawn } = translateStrip(src, offset, offset);
      const dup = { ...drawn, stripId: crypto.randomUUID() };
      return { patch: { usbStrips: [...config.usbStrips, dup] }, objectId: usbStripObjectId(dup.stripId) };
    },
    // A strip moves by its start point; the end keeps the same offset from it.
    moveTo: (config, ref, x, y) => ({
      usbStrips: config.usbStrips.map((s) => {
        if (s.stripId !== ref.stripId) return s;
        return keepStripInside(translateStrip(s, x - s.startX, y - s.startY), roomBoxOf(config));
      }),
    }),
    nudge: (cfg, ref, direction) => {
      const { dx, dy } = worldStep(direction);
      return {
        usbStrips: cfg.usbStrips.map((s) =>
          s.stripId === ref.stripId
            ? keepStripInside(translateStrip(s, dx, dy), roomBoxOf(cfg))
            : s,
        ),
      };
    },
    rotateBy: null,
    rename: null,
    inspect: (config, ref) => {
      const strip = config.usbStrips.find((s) => s.stripId === ref.stripId);
      return strip ? { kind: "usb", strip } : null;
    },
  },
  hue: {
    exists: (config, ref) => config.hueChannels.some((c) => c.channelIndex === ref.channelIndex),
    isLocked: (config, ref, { hueAreaId }) =>
      !!findScopedHueChannel(config.hueChannels, hueAreaId, ref.channelIndex)?.locked,
    toggleLock: (config, ref, visibleHueChannels) => {
      const target = visibleHueChannels.find((ch) => ch.channelIndex === ref.channelIndex);
      return target ? { hueChannels: replaceHueChannel(config.hueChannels, { ...target, locked: !target.locked }) } : null;
    },
    // Channels are bridge-managed, and a light leaves its zone through its zone picker.
    // See docs/architecture/room-map.md for the bug that removing one caused.
    remove: null,
    duplicate: null,
    moveTo: (config, ref, x, y, { hueAreaId }) => ({
      hueChannels: updateScopedHueChannel(config.hueChannels, hueAreaId, ref.channelIndex, (ch) =>
        seatMovedLight(ch, moveHueChannelToWorld(ch, config.zones, x, y), config),
      ),
    }),
    // Hue ignores Shift: its space is [-1, 1], where a metre-sized step would leave the room.
    nudge: (cfg, ref, { x, y }, { hueAreaId }) => ({
      hueChannels: updateScopedHueChannel(cfg.hueChannels, hueAreaId, ref.channelIndex, (ch) =>
        nudgeHueChannel(ch, cfg.zones, x * HUE_NUDGE_STEP, -y * HUE_NUDGE_STEP),
      ),
    }),
    rotateBy: null,
    rename: (config, ref, label, { hueAreaId }) => ({
      hueChannels: updateScopedHueChannel(config.hueChannels, hueAreaId, ref.channelIndex, (ch) => ({ ...ch, label })),
    }),
    inspect: (config, ref) => {
      const channel = findHueChannel(config.hueChannels, ref.channelIndex);
      if (!channel) return null;
      return { kind: "hueChannel", channel };
    },
  },
  image: {
    exists: (config, ref) => config.imageLayers.some((l) => l.id === ref.layerId),
    isLocked: (config, ref) => !!config.imageLayers.find((l) => l.id === ref.layerId)?.locked,
    toggleLock: (config, ref) => ({
      imageLayers: config.imageLayers.map((l) => (l.id === ref.layerId ? { ...l, locked: !l.locked } : l)),
    }),
    remove: (config, ref) => ({ imageLayers: config.imageLayers.filter((l) => l.id !== ref.layerId) }),
    duplicate: null,
    moveTo: (config, ref, x, y) => ({
      imageLayers: config.imageLayers.map((l) => (l.id === ref.layerId ? { ...l, offsetX: x, offsetY: y } : l)),
    }),
    nudge: null,
    rotateBy: null,
    rename: (config, ref, label) => ({
      imageLayers: config.imageLayers.map((l) => (l.id === ref.layerId ? { ...l, label } : l)),
    }),
    inspect: (config, ref) => {
      const layer = config.imageLayers.find((l) => l.id === ref.layerId);
      return layer ? { kind: "image", layer } : null;
    },
  },
} satisfies { [K in RoomObjectKind]: RoomObjectAdapter<K> };

/** The row for a parsed id. The one cast that ties `ref.kind` to its row's parameter types. */
export function roomObjectAdapter<K extends RoomObjectKind>(ref: RoomObjectRef<K>): RoomObjectAdapter<K> {
  return ROOM_OBJECT_KINDS[ref.kind] as unknown as RoomObjectAdapter<K>;
}
