import type { HueChannelPlacement, RoomMapConfig } from "@/shared/contracts/roomMap";
import { findHueChannel, replaceHueChannel } from "@/shared/contracts/roomMap";

import { moveHueChannelToWorld, nudgeHueChannel } from "./hueChannelPosition";
import { findScopedHueChannel, updateScopedHueChannel } from "./hueChannelScope";
import { furnitureObjectId, usbStripObjectId, type RoomObjectKind, type RoomObjectRef } from "./objectId";
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
  resize: ((config: RoomMapConfig, ref: RoomObjectRef<K>, width: number, height: number) => Patch | null) | null;
  rotateTo: ((config: RoomMapConfig, ref: RoomObjectRef<K>, rotation: number) => Patch) | null;
  rotateBy: ((config: RoomMapConfig, ref: RoomObjectRef<K>, degrees: number) => Patch) | null;
  /** The label the rename dialog opens on, and the patch that renames. */
  rename: {
    current: (config: RoomMapConfig, ref: RoomObjectRef<K>) => string;
    apply: (config: RoomMapConfig, ref: RoomObjectRef<K>, label: string) => Patch;
  } | null;
  inspect: (config: RoomMapConfig, ref: RoomObjectRef<K>) => InspectorTarget | null;
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
    moveTo: (config, _ref, x, y) => (config.tvAnchor ? { tvAnchor: { ...config.tvAnchor, x, y } } : null),
    nudge: (cfg, _ref, direction) => {
      const { dx, dy } = worldStep(direction);
      return cfg.tvAnchor ? { tvAnchor: { ...cfg.tvAnchor, x: cfg.tvAnchor.x + dx, y: cfg.tvAnchor.y + dy } } : {};
    },
    resize: (config, _ref, width, height) =>
      config.tvAnchor ? { tvAnchor: { ...config.tvAnchor, width, height } } : null,
    rotateTo: null,
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
      furniture: config.furniture.map((f) => (f.id === ref.furnitureId ? { ...f, x, y } : f)),
    }),
    nudge: (cfg, ref, direction) => {
      const { dx, dy } = worldStep(direction);
      return {
        furniture: cfg.furniture.map((f) => (f.id === ref.furnitureId ? { ...f, x: f.x + dx, y: f.y + dy } : f)),
      };
    },
    resize: (config, ref, width, height) => ({
      furniture: config.furniture.map((f) => (f.id === ref.furnitureId ? { ...f, width, height } : f)),
    }),
    rotateTo: (config, ref, rotation) => ({
      furniture: config.furniture.map((f) => (f.id === ref.furnitureId ? { ...f, rotation } : f)),
    }),
    rotateBy: (config, ref, degrees) => ({
      furniture: config.furniture.map((f) =>
        f.id === ref.furnitureId ? { ...f, rotation: ((f.rotation ?? 0) + degrees) % 360 } : f,
      ),
    }),
    rename: {
      current: (config, ref) => config.furniture.find((f) => f.id === ref.furnitureId)?.label ?? "",
      apply: (config, ref, label) => ({
        furniture: config.furniture.map((f) => (f.id === ref.furnitureId ? { ...f, label } : f)),
      }),
    },
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
    remove: (config, ref) => ({ usbStrips: config.usbStrips.filter((s) => s.stripId !== ref.stripId) }),
    duplicate: (config, ref, offset) => {
      const src = config.usbStrips.find((s) => s.stripId === ref.stripId);
      if (!src) return null;
      const dup = {
        ...src,
        stripId: crypto.randomUUID(),
        startX: src.startX + offset,
        startY: src.startY + offset,
        endX: src.endX + offset,
        endY: src.endY + offset,
      };
      return { patch: { usbStrips: [...config.usbStrips, dup] }, objectId: usbStripObjectId(dup.stripId) };
    },
    // A strip moves by its start point; the end keeps the same offset from it.
    moveTo: (config, ref, x, y) => ({
      usbStrips: config.usbStrips.map((s) => {
        if (s.stripId !== ref.stripId) return s;
        const dx = x - s.startX;
        const dy = y - s.startY;
        return { ...s, startX: x, startY: y, endX: s.endX + dx, endY: s.endY + dy };
      }),
    }),
    nudge: (cfg, ref, direction) => {
      const { dx, dy } = worldStep(direction);
      return {
        usbStrips: cfg.usbStrips.map((s) =>
          s.stripId === ref.stripId
            ? { ...s, startX: s.startX + dx, startY: s.startY + dy, endX: s.endX + dx, endY: s.endY + dy }
            : s,
        ),
      };
    },
    resize: null,
    rotateTo: null,
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
    // Channels are bridge-managed and detaching goes through "Move to →
    // Unassigned". See docs/architecture/room-map.md for the bug that removing one caused.
    remove: null,
    duplicate: null,
    moveTo: (config, ref, x, y, { hueAreaId }) => ({
      hueChannels: updateScopedHueChannel(config.hueChannels, hueAreaId, ref.channelIndex, (ch) =>
        moveHueChannelToWorld(ch, config.zones, x, y),
      ),
    }),
    // Hue ignores Shift: its space is [-1, 1], where a metre-sized step would leave the room.
    nudge: (cfg, ref, { x, y }, { hueAreaId }) => ({
      hueChannels: updateScopedHueChannel(cfg.hueChannels, hueAreaId, ref.channelIndex, (ch) =>
        nudgeHueChannel(ch, cfg.zones, x * HUE_NUDGE_STEP, -y * HUE_NUDGE_STEP),
      ),
    }),
    resize: null,
    rotateTo: null,
    rotateBy: null,
    rename: null,
    inspect: (config, ref) => {
      const channel = findHueChannel(config.hueChannels, ref.channelIndex);
      if (!channel) return null;
      const zoneName = channel.zoneId ? (config.zones.find((z) => z.id === channel.zoneId)?.name ?? null) : null;
      return { kind: "hueChannel", channel, zoneName };
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
    resize: null,
    rotateTo: null,
    rotateBy: null,
    rename: {
      current: (config, ref) => config.imageLayers.find((l) => l.id === ref.layerId)?.label ?? "",
      apply: (config, ref, label) => ({
        imageLayers: config.imageLayers.map((l) => (l.id === ref.layerId ? { ...l, label } : l)),
      }),
    },
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
