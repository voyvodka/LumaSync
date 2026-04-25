/**
 * Room Map Contracts
 *
 * Types for the 2D room map configuration, Hue channel spatial placements,
 * USB strip placements, furniture, TV anchor, and zone definitions.
 *
 * Phase 14: Contract foundation — these types are used by Phase 16 (Hue Channel
 * Position Editor) and Phase 17 (Room Map).
 *
 * Hue channel positions use native Hue coordinate space: x/y/z in [-1.0, 1.0].
 * x: -1=left, +1=right
 * y: -1=bottom, +1=top
 * z: -1=floor, +1=ceiling
 */

// ---------------------------------------------------------------------------
// Room Map Commands
// ---------------------------------------------------------------------------

export const ROOM_MAP_COMMANDS = {
  SAVE: "save_room_map",
  LOAD: "load_room_map",
} as const;

// ---------------------------------------------------------------------------
// Hue Channel Placement
// ---------------------------------------------------------------------------

/**
 * Persisted position of a Hue Entertainment Area channel in room space.
 * Replaces or supplements the bridge-reported positionX/Y.
 *
 * v1.5 W1-A1: an optional `zoneId` + `zoneRelativePosition` pair is layered
 * on top of the legacy absolute coordinates. When `zoneId` is set, the
 * `zoneRelativePosition` is the authoritative source of truth and the
 * absolute `x/y/z` are derived from `HueZone.center{X,Y,Z}` plus
 * `HueZone.scale{X,Y,Z}` at runtime. Existing call sites that only know
 * about `x/y/z` keep working unchanged (legacy flat mode).
 */
export interface HueChannelPlacement {
  /** Channel index within the entertainment area (0-based) */
  channelIndex: number;
  /** Horizontal position: -1=left wall, +1=right wall */
  x: number;
  /** Vertical position (depth/front-back): -1=back wall, +1=front (TV wall) */
  y: number;
  /** Height: -1=floor, +1=ceiling */
  z: number;
  /** Optional user-assigned label */
  label?: string;
  locked?: boolean;
  /**
   * v1.5 W1-A1 — when present, this channel is logically grouped under the
   * referenced `HueZone`. Absent ⇒ legacy absolute placement.
   */
  zoneId?: string;
  /**
   * v1.5 W1-A1 — zone-relative position in [-1, 1] × [-1, 1] × [-1, 1]
   * coordinates. Authoritative when `zoneId` is set; ignored otherwise.
   * The world-space `x/y/z` above are derived from this via
   * `HueZone.center + HueZone.scale * zoneRelativePosition`.
   */
  zoneRelativePosition?: {
    x: number;
    y: number;
    z: number;
  };
}

// ---------------------------------------------------------------------------
// USB Strip Placement
// ---------------------------------------------------------------------------

export interface UsbStripPlacement {
  stripId: string;
  /** Starting corner position on room perimeter */
  startX: number;
  startY: number;
  /** Ending corner position on room perimeter */
  endX: number;
  endY: number;
  /** Number of LEDs on this strip segment */
  ledCount: number;
  locked?: boolean;
}

// ---------------------------------------------------------------------------
// Furniture Placement
// ---------------------------------------------------------------------------

export interface FurniturePlacement {
  id: string;
  type: "sofa" | "table" | "chair" | "other";
  x: number;
  y: number;
  width: number;
  height: number;
  /** Rotation in degrees (0-360) */
  rotation?: number;
  label?: string;
  locked?: boolean;
}

// ---------------------------------------------------------------------------
// TV Anchor Placement
// ---------------------------------------------------------------------------

export interface TvAnchorPlacement {
  /** Center position of the TV */
  x: number;
  y: number;
  /** TV width in room units */
  width: number;
  /** TV height in room units */
  height: number;
  locked?: boolean;
}

// ---------------------------------------------------------------------------
// Room Dimensions
// ---------------------------------------------------------------------------

export interface RoomDimensions {
  /** Width in meters */
  widthMeters: number;
  /** Depth in meters */
  depthMeters: number;
  /** Height in meters (ceiling) */
  heightMeters: number;
}

// ---------------------------------------------------------------------------
// Zone Definition
// ---------------------------------------------------------------------------

export interface ZoneDefinition {
  id: string;
  name: string;
  /** Channel indices assigned to this zone */
  channelIndices: number[];
  /** Zone region hint (maps to region assignment system) */
  region?: string;
}

// ---------------------------------------------------------------------------
// Hue Zone (v1.5 W1-A1 — logical subset of an entertainment area)
// ---------------------------------------------------------------------------

/**
 * Logical grouping of channels inside a single Hue entertainment area.
 *
 * Scope decision (v1.5 D2 — locked, scope (a) "logical grouping"):
 * - A zone is purely a UI / authoring concept: one entertainment area
 *   stream is still negotiated with the bridge, no multi-stream mux,
 *   no bridge state-machine changes.
 * - Channels inside the zone keep their bridge-assigned `channelIndex`
 *   inside the parent entertainment area.
 * - The zone provides a center-relative coordinate space so the user
 *   can manipulate a small subset of bulbs (e.g. a sofa back-light pair)
 *   as a unit without re-typing world coordinates.
 *
 * Coordinate system: same Hue native space as `HueChannelPlacement` —
 * `centerX/Y/Z` and `scaleX/Y/Z` are in [-1, 1]. The world-space position
 * of a zone-bound channel resolves to:
 *
 *   world = center + scale * zoneRelativePosition
 *
 * `borderColor` / `centerColor` are pure UI hints used by the room-map
 * editor; they have no streaming side effect.
 *
 * This is the foundation for v2.0 G3 (in-app Entertainment-area editor)
 * and `project_hue_zone_plan.md`'s multi-zone authoring story.
 */
export interface HueZone {
  /** Stable id used by `HueChannelPlacement.zoneId`. */
  id: string;
  /** Human-readable label shown in the zone editor. */
  name: string;
  /** Parent entertainment area id (one zone never spans two areas). */
  entertainmentAreaId: string;
  /** Zone center in Hue native space ([-1, 1]). */
  centerX: number;
  centerY: number;
  centerZ: number;
  /**
   * Zone-to-world scale per axis. `1.0` ⇒ zone-relative `[-1, 1]` covers
   * the full Hue space; `0.25` ⇒ zone occupies a tight cluster around
   * the center.
   */
  scaleX: number;
  scaleY: number;
  scaleZ: number;
  /** Channel indices (within the parent area) that belong to this zone. */
  channelIndices: number[];
  /** Optional UI hint for the zone outline color. */
  borderColor?: string;
  /** Optional UI hint for the zone center marker color. */
  centerColor?: string;
}

// ---------------------------------------------------------------------------
// Image Layer
// ---------------------------------------------------------------------------

export interface ImageLayer {
  id: string;
  /** Absolute path to the image file */
  path: string;
  /** Display label (filename without extension) */
  label: string;
  /** Offset X in object-layer pixels */
  offsetX: number;
  /** Offset Y in object-layer pixels */
  offsetY: number;
  /** Scale factor (1 = original size) */
  scale: number;
  /** Separate X scale factor — used when aspect ratio is unlocked */
  scaleX?: number;
  /** Separate Y scale factor — used when aspect ratio is unlocked */
  scaleY?: number;
  /** Opacity 0-100 (default 100) */
  opacity?: number;
  /** Whether this layer is locked (cannot be moved/deleted) */
  locked?: boolean;
  /** Aspect ratio lock (default true) */
  aspectLocked?: boolean;
}

// ---------------------------------------------------------------------------
// Room Map Config
// ---------------------------------------------------------------------------

/**
 * Full room map configuration persisted via shellStore.
 * Optional fields allow partial configurations during initial setup.
 */
export interface RoomMapConfig {
  dimensions: RoomDimensions;
  hueChannels: HueChannelPlacement[];
  usbStrips: UsbStripPlacement[];
  furniture: FurniturePlacement[];
  tvAnchor?: TvAnchorPlacement;
  zones: ZoneDefinition[];
  /**
   * v1.5 W1-A1 — logical Hue zones (subsets of entertainment areas).
   * Absent ⇒ legacy flat mode (channels use absolute Hue coordinates
   * directly). Distinct from `zones` above, which are USB-side region
   * groupings.
   */
  hueZones?: HueZone[];
  /** Image layers (floor plans, reference images, etc.) */
  imageLayers: ImageLayer[];
  /** @deprecated Use imageLayers instead — kept for migration */
  backgroundImagePath?: string;
  /** @deprecated */
  backgroundOffsetX?: number;
  /** @deprecated */
  backgroundOffsetY?: number;
  /** @deprecated */
  backgroundScale?: number;
  /** Custom room origin X position in metres (defaults to room center) */
  originX?: number;
  /** Custom room origin Y position in metres (defaults to room center) */
  originY?: number;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_ROOM_DIMENSIONS: RoomDimensions = {
  widthMeters: 5,
  depthMeters: 4,
  heightMeters: 2.5,
};

export const DEFAULT_ROOM_MAP: RoomMapConfig = {
  dimensions: DEFAULT_ROOM_DIMENSIONS,
  hueChannels: [],
  usbStrips: [],
  furniture: [],
  zones: [],
  imageLayers: [],
};
