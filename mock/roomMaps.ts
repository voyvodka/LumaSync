/**
 * Room-map content, as `RoomMapConfig` values the panel can drop into
 * `shellState.roomMap`.
 *
 * The editor is the one surface the rest of the mock could not reach. Every
 * other screen is driven by a command the fixtures answer; the room map is
 * driven entirely by persisted state, so an empty `shellState` meant the
 * editor always opened on a blank grid. Everything interesting about it —
 * dragging a channel that belongs to a zone, a strip bound to a port that is
 * no longer connected, a gapped `channelIndex` — needs content to exist first,
 * and authoring that content by hand through the editor takes several minutes
 * every time the world is reset.
 *
 * The presets are not prettier versions of each other. Each is a shape the
 * editor has to handle and would otherwise only meet in a user's file.
 */

import {
  HUE_CHANNEL_HEIGHT_ORIGIN,
  type HueChannelHeightOrigin,
  type HueChannelPlacement,
  type HueZone,
  type RoomMapConfig,
  type TvAnchorPlacement,
} from "../src/shared/contracts/roomMap";

export const ROOM_MAP_PRESET_IDS = ["none", "simple", "zoned", "legacy-gapped", "tv-anchored"] as const;

export type RoomMapPresetId = (typeof ROOM_MAP_PRESET_IDS)[number];

export interface RoomMapPreset {
  id: RoomMapPresetId;
  label: string;
  /** One line saying what this shape makes reachable. */
  summary: string;
  build: () => RoomMapConfig | undefined;
}

const DIMENSIONS = { widthMeters: 5.2, depthMeters: 4.1, heightMeters: 2.6 };

// Room-metre frame throughout this file (see `TvAnchorPlacement` on the
// contract): origin at the TV-wall/left-wall floor corner, +x toward the
// right wall, +y away from the TV wall. x/y is each object's top-left
// corner, never its centre — furniture and the TV anchor both live here.
// Hue channel x/y/z stay in the separate native [-1, 1] frame documented at
// the top of `roomMap.ts` and are untouched by this note.
const FURNITURE: RoomMapConfig["furniture"] = [
  { id: "sofa-1", type: "sofa", x: 1.55, y: 2.9, width: 2.1, height: 0.9, rotation: 0, label: "Sofa" },
  { id: "table-1", type: "table", x: 2.05, y: 1.9, width: 1.1, height: 0.6, rotation: 0, label: "Coffee table" },
  { id: "chair-1", type: "chair", x: 0.4, y: 2.2, width: 0.6, height: 0.6, rotation: 35, label: "Armchair" },
];

const TV_ANCHOR: TvAnchorPlacement = {
  x: (DIMENSIONS.widthMeters - 1.6) / 2,
  y: 0.15,
  width: 1.6,
  height: 0.08,
};

function channel(
  channelIndex: number,
  x: number,
  y: number,
  z: number,
  label: string,
  zOrigin?: HueChannelHeightOrigin,
): HueChannelPlacement {
  return {
    channelIndex,
    entertainmentAreaId: "area-living",
    channelId: channelIndex,
    x,
    y,
    z,
    label,
    locked: false,
    ...(zOrigin ? { zOrigin } : {}),
  };
}

/** A plain map: four channels placed absolutely, one strip, some furniture. */
function simple(): RoomMapConfig {
  return {
    dimensions: DIMENSIONS,
    hueChannels: [
      channel(0, -0.8, -0.6, 0.1, "Left strip"),
      channel(1, 0.8, -0.6, 0.1, "Right strip"),
      channel(2, 0, 0.4, 0.9, "Ceiling"),
      channel(3, -0.9, 0.7, -0.4, "Lamp"),
    ],
    usbStrips: [
      {
        stripId: "strip-tv",
        startX: 0.3,
        startY: 0.05,
        endX: 4.9,
        endY: 0.05,
        ledCount: 164,
        portName: "/dev/cu.usbserial-1420",
      },
    ],
    furniture: FURNITURE,
    tvAnchor: TV_ANCHOR,
    zones: [],
    imageLayers: [],
  };
}

const LIVING_ZONE: HueZone = {
  id: "zone-living",
  name: "Living room",
  entertainmentAreaId: "area-living",
  centerX: 0,
  centerY: 0.2,
  centerZ: 0,
  scaleX: 0.8,
  scaleY: 0.6,
  scaleZ: 0.5,
  channelIndices: [0, 1, 2],
};

/**
 * Three channels inside a zone, one left outside it.
 *
 * The mixed case is the point. Zone membership changes which coordinate is
 * authoritative — `zoneRelativePosition` for a member, absolute `x/y/z` for
 * everyone else — so a map where every channel is a member, or none is, never
 * exercises the branch that resolves the two against each other.
 */
function zoned(): RoomMapConfig {
  const base = simple();
  return {
    ...base,
    zones: [LIVING_ZONE],
    hueChannels: base.hueChannels.map((placement) =>
      LIVING_ZONE.channelIndices.includes(placement.channelIndex)
        ? {
            ...placement,
            zoneId: LIVING_ZONE.id,
            zoneRelativePosition: {
              x: (placement.x - LIVING_ZONE.centerX) / LIVING_ZONE.scaleX,
              y: (placement.y - LIVING_ZONE.centerY) / LIVING_ZONE.scaleY,
              z: (placement.z - LIVING_ZONE.centerZ) / LIVING_ZONE.scaleZ,
            },
          }
        : placement,
    ),
  };
}

/**
 * A map as v1.4 and earlier wrote them: `channelIndex` values with holes in
 * them, no `entertainmentAreaId`, and a strip with no `portName`.
 *
 * `docs/architecture/room-map.md` warns never to index `hueChannels` by array
 * position, and this is the fixture that makes the difference observable: the
 * indices here are 0, 2 and 5, so any consumer that reads position 1 gets the
 * wrong channel rather than nothing.
 */
function legacyGapped(): RoomMapConfig {
  return {
    dimensions: DIMENSIONS,
    hueChannels: [
      { channelIndex: 0, x: -0.8, y: -0.6, z: 0.1, label: "Left strip" },
      { channelIndex: 2, x: 0.8, y: -0.6, z: 0.1, label: "Right strip" },
      { channelIndex: 5, x: 0, y: 0.4, z: 0.9, label: "Ceiling" },
    ],
    usbStrips: [
      { stripId: "strip-legacy", startX: 0.5, startY: 0.05, endX: 4.5, endY: 0.05, ledCount: 120 },
    ],
    furniture: FURNITURE,
    zones: [],
    imageLayers: [],
  };
}

const TV_ANCHOR_MOUNTED: TvAnchorPlacement = {
  ...TV_ANCHOR,
  // Explicit mount height — the room-aware sampler has no snapshot fallback
  // to fall back on once a `RoomGeometry` carries this, unlike the 40%-of
  // -room-height default `mountHeightMeters` gets when absent.
  mountHeightMeters: 1.35,
};

/**
 * A TV anchor with a known mount height, plus Hue channels whose `z` origin
 * is recorded (mixed `bridge`/`user`, mixed floor/mid/ceiling) — the shape
 * the room-aware sampler needs once the frontend starts sending
 * `RoomGeometry` on stream start. `simple` and `zoned` both predate height
 * tracking, so every channel there has `zOrigin` absent (unknown-origin),
 * which is a real state but not this one.
 */
function tvAnchored(): RoomMapConfig {
  return {
    dimensions: DIMENSIONS,
    hueChannels: [
      channel(0, -0.85, -0.7, -0.95, "Floor left", HUE_CHANNEL_HEIGHT_ORIGIN.USER),
      channel(1, 0.85, -0.7, -0.95, "Floor right", HUE_CHANNEL_HEIGHT_ORIGIN.USER),
      channel(2, -0.9, 0.1, 0.05, "Shelf", HUE_CHANNEL_HEIGHT_ORIGIN.BRIDGE),
      channel(3, 0, 0.5, 0.95, "Ceiling", HUE_CHANNEL_HEIGHT_ORIGIN.BRIDGE),
    ],
    usbStrips: [
      {
        stripId: "strip-tv-mounted",
        startX: 0.3,
        startY: 0.05,
        endX: 4.9,
        endY: 0.05,
        ledCount: 164,
        portName: "/dev/cu.usbserial-1420",
      },
    ],
    furniture: FURNITURE,
    tvAnchor: TV_ANCHOR_MOUNTED,
    zones: [],
    imageLayers: [],
  };
}

export const ROOM_MAP_PRESETS: Record<RoomMapPresetId, RoomMapPreset> = {
  none: {
    id: "none",
    label: "No room map",
    summary: "The editor's own empty state — what a user sees before authoring one.",
    build: () => undefined,
  },
  simple: {
    id: "simple",
    label: "Furnished, no zones",
    summary: "Four absolutely-placed channels, one strip, furniture and a TV anchor.",
    build: simple,
  },
  zoned: {
    id: "zoned",
    label: "Zoned",
    summary: "Three channels inside a Hue zone, one outside it — the mixed resolution path.",
    build: zoned,
  },
  "legacy-gapped": {
    id: "legacy-gapped",
    label: "Legacy, gapped indices",
    summary: "Pre-v1.5 shape: channelIndex 0/2/5, no area id, strip with no port.",
    build: legacyGapped,
  },
  "tv-anchored": {
    id: "tv-anchored",
    label: "TV-anchored, known heights",
    summary: "TV with an explicit mount height, channels with recorded floor/mid/ceiling z-origins.",
    build: tvAnchored,
  },
};
