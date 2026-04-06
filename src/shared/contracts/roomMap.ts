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
  /** Path to a user-provided background floor plan image */
  backgroundImagePath?: string;
  /** Background image offset in metres from canvas top-left */
  backgroundOffsetX?: number;
  backgroundOffsetY?: number;
  /** Background image scale factor (1 = fit to canvas, >1 = zoomed in) */
  backgroundScale?: number;
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
};
