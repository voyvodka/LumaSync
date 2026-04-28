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
 *
 * v1.5 W4-F2 (2026-04-28): the W4-F unification (`Zone` discriminated by
 * `zoneType: "logical" | "hue"`) is rolled forward into a single Hue-only
 * surface. The "logical zone" concept has no clean industry analog and is
 * dropped entirely; only `HueZone` (spatial 3D, mirroring Hue Entertainment
 * Area channels) survives. Future zone kinds — `ScreenZone` (Hyperion-style
 * screen rectangles) and `LedZone` (USB-side grouping) — will land later as
 * separate, explicit-prefix types in their own modules and are NOT wired
 * through this contract. See `.planning/RFCs/v1.5-w4-f-zone-unification.md`
 * "Direction reversal (2026-04-28)".
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
 *
 * v1.5 W4-F2: `zoneId` references a `HueZone` (the only surviving zone
 * kind after the direction reversal — logical zones were dropped).
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
  /**
   * Wave 4-G #6 — USB serial port the strip is bound to (e.g.
   * `/dev/tty.usbserial-110`). Multiple `UsbStripPlacement` rows can
   * share the same `portName` so a single controller can host
   * multiple physical segments. Optional for backwards compatibility
   * with strips authored before W4-G; consumers must treat `undefined`
   * as "not yet linked" and surface a re-pair affordance instead of
   * blocking the user.
   */
  portName?: string;
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
// Hue Zone (v1.5 W4-F2 — sole surviving zone kind, Hue Entertainment Area
// spatial 3D subset). Logical / screen / LED zones intentionally NOT wired
// into this contract; they ship later as explicit-prefix types in their own
// modules.
// ---------------------------------------------------------------------------

/**
 * Hue Entertainment Area zone descriptor. A `HueZone` represents a named
 * 3D-positioned subset of an entertainment area's channels — the user
 * authors the zone as a physical bounding box (center + per-axis scale)
 * and channels reference the zone via `HueChannelPlacement.zoneId`. The
 * runtime sampler resolves world-space coordinates as
 * `world = center + scale * zoneRelativePosition`.
 *
 * Coordinate system: same Hue native space as `HueChannelPlacement` —
 * `centerX/Y/Z` and `scaleX/Y/Z` are in `[-1, 1]`. The bridge per-area
 * channel cap (10) applies to `channelIndices`.
 *
 * `borderColor` is a UI hint for the dashed bounds box and channel ring
 * tint; the runtime sampler never reads it.
 */
export interface HueZone {
  /** Stable id used by `HueChannelPlacement.zoneId`. */
  id: string;
  /** Human-readable label shown in the zone editor. */
  name: string;
  /**
   * Parent entertainment area id (one Hue zone never spans two areas).
   */
  entertainmentAreaId: string;
  /** Zone center X in Hue native space ([-1, 1]). */
  centerX: number;
  /** Zone center Y in Hue native space ([-1, 1]). */
  centerY: number;
  /** Zone center Z in Hue native space ([-1, 1]). */
  centerZ: number;
  /** Per-axis zone-to-world scale. `1.0` ⇒ zone covers full Hue space. */
  scaleX: number;
  /** Per-axis zone-to-world scale. */
  scaleY: number;
  /** Per-axis zone-to-world scale. */
  scaleZ: number;
  /**
   * Entertainment-area channel indices (0-based, bounded by the bridge's
   * per-area cap of 10).
   */
  channelIndices: number[];
  /**
   * Optional UI hint for the zone outline color. Drives the dashed bounds
   * box and the channel ring rendered by `HueChannelOverlay`. Falls back
   * to the amber Rev 07 token when absent. The runtime sampler ignores
   * this field.
   */
  borderColor?: string;
  /**
   * @deprecated v1.5 — collapsed onto `borderColor` after manual testing
   * showed the dual-color affordance was confusing. Kept on the contract
   * so previously persisted configs deserialise without loss; new
   * authoring flows MUST NOT write this field.
   */
  centerColor?: string;
}

// ---------------------------------------------------------------------------
// Legacy zone shapes (v1.5 W4-F2 migration shim — read-only fallbacks)
// ---------------------------------------------------------------------------

/**
 * @deprecated v1.5 W4-F2 — read-only legacy migration shape. The original
 * v1.5 W1-A1 `HueZone` interface (pre-W4-F unification) had the same
 * structural shape as the canonical `HueZone` above. Kept under the
 * `LegacyHueZone` name so `migrateLegacyHueZone` can validate persisted
 * records during the one-shot `schemaVersion: 1 → 2` migration without
 * colliding with the new canonical type.
 *
 * Note that the structural layout is identical to `HueZone`; the rename
 * exists purely so the migration helper has a distinct compile-time
 * type to anchor on.
 */
export interface LegacyHueZone {
  id: string;
  name: string;
  entertainmentAreaId: string;
  centerX: number;
  centerY: number;
  centerZ: number;
  scaleX: number;
  scaleY: number;
  scaleZ: number;
  channelIndices: number[];
  borderColor?: string;
  /**
   * @deprecated v1.5 — collapsed onto `borderColor` after manual
   * testing showed the dual-color affordance was confusing.
   */
  centerColor?: string;
}

/**
 * @deprecated v1.5 W4-F2 — read-only legacy migration shape. Pre-W4-F
 * USB-side region grouping. The W4-F unification briefly tried to
 * promote this into a generic `Zone & { zoneType: "logical" }`; the
 * reversal dropped the concept entirely. The interface survives only so
 * the migration shim can detect previously persisted records and DROP
 * them with a `console.warn`. New code paths MUST NOT consume this
 * type. See `.planning/RFCs/v1.5-w4-f-zone-unification.md` "Direction
 * reversal".
 */
export interface ZoneDefinition {
  id: string;
  name: string;
  /** Channel indices assigned to this zone */
  channelIndices: number[];
  /** Zone region hint (maps to region assignment system) */
  region?: string;
}

// ---------------------------------------------------------------------------
// Migration helpers (v1.5 W4-F2 — pure functions consumed by F6 shim)
// ---------------------------------------------------------------------------

/**
 * Internal helper — guards a legacy persisted record against the most common
 * corruption shapes seen in plaintext on-disk JSON: `null`, non-object,
 * `Array.isArray`, missing fields. Centralised so the migration helper
 * reuses a single gate.
 */
function isPlainLegacyRecord(legacy: unknown): legacy is Record<string, unknown> {
  return (
    typeof legacy === "object" &&
    legacy !== null &&
    !Array.isArray(legacy)
  );
}

/** True when `value` is a finite, non-NaN number. */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Convert a `LegacyHueZone` (pre-W4-F2 persisted shape, structurally
 * identical to the canonical `HueZone` but typed separately so the
 * migration is anchored at compile time) into a canonical `HueZone`.
 * Pure function — safe to call in any context.
 *
 * Used by the `schemaVersion 1 → 2` migration shim. This helper is
 * exported here (not inside `loadShellState`) so the migration is
 * testable in isolation.
 *
 * Returns `null` and emits `console.warn` when the input fails the Hue
 * shape gate (non-object, missing/empty `id` / `name` /
 * `entertainmentAreaId`, non-finite `centerX/Y/Z` or `scaleX/Y/Z`,
 * non-array `channelIndices`). Migration callers MUST filter `null`
 * results so corrupt records are dropped instead of corrupting the
 * `zones[]` array. See `.planning/RFCs/v1.5-w4-f-zone-unification.md`
 * §7 #1.
 */
export function migrateLegacyHueZone(legacy: LegacyHueZone): HueZone | null {
  if (!isPlainLegacyRecord(legacy)) {
    console.warn(
      "[LumaSync] migration: dropping corrupt LegacyHueZone (not a plain object)",
      legacy,
    );
    return null;
  }

  const id = legacy.id;
  const name = legacy.name;
  const entertainmentAreaId = legacy.entertainmentAreaId;
  const channelIndices = legacy.channelIndices;

  if (typeof id !== "string" || id.length === 0) {
    console.warn(
      "[LumaSync] migration: dropping corrupt LegacyHueZone (missing id)",
      legacy,
    );
    return null;
  }
  if (typeof name !== "string" || name.length === 0) {
    console.warn(
      "[LumaSync] migration: dropping corrupt LegacyHueZone (missing name)",
      legacy,
    );
    return null;
  }
  if (typeof entertainmentAreaId !== "string" || entertainmentAreaId.length === 0) {
    console.warn(
      "[LumaSync] migration: dropping corrupt LegacyHueZone (missing entertainmentAreaId)",
      legacy,
    );
    return null;
  }
  if (
    !isFiniteNumber(legacy.centerX) ||
    !isFiniteNumber(legacy.centerY) ||
    !isFiniteNumber(legacy.centerZ)
  ) {
    console.warn(
      "[LumaSync] migration: dropping corrupt LegacyHueZone (non-finite center coordinates)",
      legacy,
    );
    return null;
  }
  if (
    !isFiniteNumber(legacy.scaleX) ||
    !isFiniteNumber(legacy.scaleY) ||
    !isFiniteNumber(legacy.scaleZ)
  ) {
    console.warn(
      "[LumaSync] migration: dropping corrupt LegacyHueZone (non-finite scale)",
      legacy,
    );
    return null;
  }
  if (!Array.isArray(channelIndices)) {
    console.warn(
      "[LumaSync] migration: dropping corrupt LegacyHueZone (channelIndices not an array)",
      legacy,
    );
    return null;
  }

  return {
    id,
    name,
    entertainmentAreaId,
    centerX: legacy.centerX,
    centerY: legacy.centerY,
    centerZ: legacy.centerZ,
    scaleX: legacy.scaleX,
    scaleY: legacy.scaleY,
    scaleZ: legacy.scaleZ,
    channelIndices,
    borderColor: legacy.borderColor,
  };
}

// ---------------------------------------------------------------------------
// Hue Zone command surface (v1.5 W4-F2 — Hue-only after the direction
// reversal; the W4-F generic `ZONE_COMMANDS` map is replaced 1:1 by the
// renamed Hue-only map below).
// ---------------------------------------------------------------------------

/**
 * Authoring commands for `HueZone[]`. Backend dispatch is single-branch
 * (no `zoneType` discriminator after the W4-F2 reversal). The four
 * verbs map 1:1 to the four Rust handlers under
 * `src-tauri/src/commands/room_map/hue_zone.rs`.
 */
export const HUE_ZONE_COMMANDS = {
  CREATE_HUE_ZONE: "create_hue_zone",
  UPDATE_HUE_ZONE: "update_hue_zone",
  DELETE_HUE_ZONE: "delete_hue_zone",
  ASSIGN_CHANNEL_TO_HUE_ZONE: "assign_channel_to_hue_zone",
} as const;

export type HueZoneCommandId =
  (typeof HUE_ZONE_COMMANDS)[keyof typeof HUE_ZONE_COMMANDS];

// ---------------------------------------------------------------------------
// Hue Zone status codes (v1.5 W4-F2 — Hue-only after the direction reversal,
// renamed from the W4-F generic `ZONE_*` family back to `HUE_ZONE_*`).
// ---------------------------------------------------------------------------

/**
 * Status codes emitted by the four Hue zone authoring commands. After the
 * v1.5 W4-F2 direction reversal these codes are Hue-only — the W4-F
 * `ZONE_TYPE_INVALID` and `ZONE_CONVERSION_OK` codes (which only made
 * sense in a logical/Hue discriminated world) are gone.
 *
 * The eight surviving codes mirror the original v1.5 W1-A2 baseline. The
 * Rust constants will catch up in the paired `hue-expert` spawn.
 */
export const HUE_ZONE_STATUS_CODES = {
  /** `create_hue_zone` succeeded; the new zone id is in the payload. */
  HUE_ZONE_CREATED: "HUE_ZONE_CREATED",
  /** `update_hue_zone` succeeded; the mutated zone is in the payload. */
  HUE_ZONE_UPDATED: "HUE_ZONE_UPDATED",
  /** `delete_hue_zone` succeeded; channels formerly in the zone fall back to legacy absolute placement. */
  HUE_ZONE_DELETED: "HUE_ZONE_DELETED",
  /** Referenced zone id does not exist in the active room map. */
  HUE_ZONE_NOT_FOUND: "HUE_ZONE_NOT_FOUND",
  /**
   * Zone-relative position is outside the [-1, 1] cube on at least one
   * axis.
   */
  HUE_ZONE_CHANNEL_OUT_OF_BOUNDS: "HUE_ZONE_CHANNEL_OUT_OF_BOUNDS",
  /**
   * Per-area bridge channel cap (Hue: 10 per area) reached.
   */
  HUE_ZONE_LIMIT_REACHED: "HUE_ZONE_LIMIT_REACHED",
  /**
   * Tried to assign a channel that lives in a different entertainment
   * area than the zone's `entertainmentAreaId`.
   */
  HUE_ZONE_CHANNEL_NOT_IN_AREA: "HUE_ZONE_CHANNEL_NOT_IN_AREA",
  /**
   * Zone scale exceeds the room or undershoots the slider floor (per-axis
   * `[0.05, 1.0]` clamp). See v1.5 W4-I notes — the previous uniform
   * aspect-ratio lock was dropped, zones are authored as physical 1:1
   * metric squares, so a non-square room deliberately writes asymmetric
   * `scaleX` / `scaleY`.
   */
  HUE_ZONE_OVERSIZED: "HUE_ZONE_OVERSIZED",
} as const;

export type HueZoneStatusCode =
  (typeof HUE_ZONE_STATUS_CODES)[keyof typeof HUE_ZONE_STATUS_CODES];

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
 *
 * v1.5 W4-F2: `zones: HueZone[]` is the single Hue-only zone array (the
 * W4-F unified discriminator was rolled back — see RFC "Direction
 * reversal"). The legacy `hueZones?: LegacyHueZone[]` field stays on the
 * contract as a `@deprecated` read-only fallback so the F6 migration
 * shim can fold leftover plaintext-on-disk states from in-development
 * W1-A1 builds. New code paths MUST NOT write `hueZones` — write into
 * `zones[]` instead.
 */
export interface RoomMapConfig {
  dimensions: RoomDimensions;
  hueChannels: HueChannelPlacement[];
  usbStrips: UsbStripPlacement[];
  furniture: FurniturePlacement[];
  tvAnchor?: TvAnchorPlacement;
  /**
   * Hue zone list (v1.5 W4-F2 — Hue-only after the direction reversal).
   * Each entry is a `HueZone`; logical / screen / LED zones are NOT
   * stored here and will land later in their own arrays.
   */
  zones: HueZone[];
  /**
   * @deprecated v1.5 W4-F2 — read-only fallback during migration shim
   * window. The F6 migration converts these into `zones[]: HueZone[]`
   * entries and strips the field on next save. New code paths MUST NOT
   * write here.
   */
  hueZones?: LegacyHueZone[];
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
