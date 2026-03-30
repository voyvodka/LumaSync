/**
 * Room Map Contracts
 *
 * All type definitions for the v1.2 2D room map editor, Hue channel editor,
 * zone derivation, and furniture/anchor placement features.
 *
 * Requirements served: ROOM-01 through ROOM-08, CHAN-01 through CHAN-05,
 * ZONE-01 through ZONE-03, STND-01 through STND-03.
 */

// ---------------------------------------------------------------------------
// Room Dimensions (ROOM-01)
// ---------------------------------------------------------------------------

/**
 * Physical room dimensions in meters.
 * Serves ROOM-01: user can specify room size for the 2D map canvas.
 */
export interface RoomDimensions {
  /** Room width in meters */
  widthMeters: number;
  /** Room depth in meters */
  depthMeters: number;
}

// ---------------------------------------------------------------------------
// Hue Channel Placement (CHAN-01, CHAN-02, CHAN-03, CHAN-04, ROOM-04, D-01a, D-03)
// ---------------------------------------------------------------------------

/**
 * Hue Entertainment Area channel placement on the room map.
 *
 * Uses Hue's native coordinate range [-1.0, 1.0] for x and y (D-01a).
 * This allows direct write-back to the bridge without conversion (D-01c, CHAN-05).
 * Serves both CHAN-* and ROOM-04 requirements per D-03 decision:
 * Hue channel = Hue light source on the room map.
 */
export interface HueChannelPlacement {
  /** 0-based index matching the Hue bridge channel index (CHAN-01) */
  channelIndex: number;
  /** Horizontal position in Hue native range [-1.0, 1.0] (D-01a, CHAN-02) */
  x: number;
  /** Depth/forward position in Hue native range [-1.0, 1.0] (D-01a, CHAN-02) */
  y: number;
  /** Height position in Hue native range [-1.0, 1.0] (CHAN-03) */
  z: number;
  /** Optional user-visible label for this channel (CHAN-04) */
  label?: string;
}

// ---------------------------------------------------------------------------
// USB Strip Placement (ROOM-05, D-01b)
// ---------------------------------------------------------------------------

/**
 * USB WS2812B LED strip placement on the room map.
 *
 * Uses unbounded float coordinates (D-01b) — no movement restrictions.
 * Serves ROOM-05: user can see LED strip positions on the 2D map.
 */
export interface UsbStripPlacement {
  /** Unique identifier for this strip placement */
  id: string;
  /** Which wall this strip is mounted on */
  wallSide: "top" | "right" | "bottom" | "left";
  /** Number of addressable LEDs on this strip */
  ledCount: number;
  /** 0.0–1.0 normalized offset: where along the wall the strip starts */
  offsetRatio: number;
  /** Horizontal position as unbounded float (D-01b) */
  x: number;
  /** Vertical/depth position as unbounded float (D-01b) */
  y: number;
}

// ---------------------------------------------------------------------------
// Furniture Placement (ROOM-02, D-01b)
// ---------------------------------------------------------------------------

/**
 * Furniture item placement on the room map.
 *
 * Uses unbounded float coordinates (D-01b).
 * Serves ROOM-02: user can place furniture to visualize room layout context.
 */
export interface FurniturePlacement {
  /** Unique identifier for this furniture item */
  id: string;
  /** User-visible furniture name (e.g. "Sofa", "Desk") */
  name: string;
  /** Furniture width in meters */
  widthMeters: number;
  /** Furniture depth in meters */
  depthMeters: number;
  /** Rotation angle in degrees, 0–360 */
  rotation: number;
  /** Horizontal position as unbounded float (D-01b) */
  x: number;
  /** Vertical/depth position as unbounded float (D-01b) */
  y: number;
}

// ---------------------------------------------------------------------------
// TV Anchor Placement (ROOM-06, D-01b)
// ---------------------------------------------------------------------------

/**
 * TV screen anchor placement on the room map.
 *
 * Uses unbounded float coordinates (D-01b).
 * Serves ROOM-06: user can anchor the TV position for spatial reference.
 */
export interface TvAnchorPlacement {
  /** TV screen width in meters */
  widthMeters: number;
  /** TV screen height in meters */
  heightMeters: number;
  /** Horizontal position as unbounded float (D-01b) */
  x: number;
  /** Vertical/depth position as unbounded float (D-01b) */
  y: number;
}

// ---------------------------------------------------------------------------
// Zone Definition (ROOM-03, ZONE-01, ZONE-02, ZONE-03)
// ---------------------------------------------------------------------------

/**
 * A named zone grouping Hue channels and/or USB strips.
 *
 * Serves ROOM-03, ZONE-01 through ZONE-03: user can define lighting zones
 * that combine multiple light sources for unified control.
 * `lightIds` references either:
 *   - HueChannelPlacement.channelIndex serialized as a string (e.g. "0", "1")
 *   - UsbStripPlacement.id
 */
export interface ZoneDefinition {
  /** Unique identifier for this zone */
  id: string;
  /** User-visible zone name */
  name: string;
  /** IDs of light sources in this zone (channel indices as strings or strip IDs) */
  lightIds: string[];
}

// ---------------------------------------------------------------------------
// Room Map Config (D-02a — separate typed arrays, NOT discriminated union)
// ---------------------------------------------------------------------------

/**
 * Top-level room map configuration persisted to shell state.
 *
 * Uses separate typed arrays per D-02a decision:
 * each placement type carries its own domain-specific fields.
 * Serves ROOM-01 through ROOM-08, and all CHAN/ZONE requirements via sub-types.
 */
export interface RoomMapConfig {
  /** Physical room dimensions */
  dimensions: RoomDimensions;
  /** Hue entertainment area channel placements */
  hueChannels: HueChannelPlacement[];
  /** USB LED strip placements */
  usbStrips: UsbStripPlacement[];
  /** Furniture placements for room layout context */
  furniture: FurniturePlacement[];
  /** Optional TV screen anchor for spatial reference (ROOM-06) */
  tvAnchor?: TvAnchorPlacement;
  /** User-defined lighting zones (ROOM-03, ZONE-01 through ZONE-03) */
  zones: ZoneDefinition[];
  /**
   * Optional path to a user-uploaded room background image.
   * Serves ROOM-08: user can upload a floor plan as map background.
   */
  backgroundImagePath?: string;
}

// ---------------------------------------------------------------------------
// Room Map Commands (following HUE_COMMANDS pattern)
// ---------------------------------------------------------------------------

/** Canonical Tauri command names for room map operations */
export const ROOM_MAP_COMMANDS = {
  SAVE_ROOM_MAP: "save_room_map",
  LOAD_ROOM_MAP: "load_room_map",
} as const;

export type RoomMapCommand =
  (typeof ROOM_MAP_COMMANDS)[keyof typeof ROOM_MAP_COMMANDS];
