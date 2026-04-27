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
 * absolute `x/y/z` are derived from `Zone.center{X,Y,Z}` plus
 * `Zone.scale{X,Y,Z}` at runtime. Existing call sites that only know
 * about `x/y/z` keep working unchanged (legacy flat mode).
 *
 * v1.5 W4-F: `zoneId` references a unified `Zone` whose `zoneType === "hue"`
 * (resolution is a no-op for `zoneType === "logical"` — logical zones never
 * own zone-relative coordinates).
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
   * referenced `Zone` (with `zoneType === "hue"`). Absent ⇒ legacy
   * absolute placement.
   */
  zoneId?: string;
  /**
   * v1.5 W1-A1 — zone-relative position in [-1, 1] × [-1, 1] × [-1, 1]
   * coordinates. Authoritative when `zoneId` is set; ignored otherwise.
   * The world-space `x/y/z` above are derived from this via
   * `Zone.center + Zone.scale * zoneRelativePosition`.
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
// Zone (v1.5 W4-F — unified `Zone` replacing `ZoneDefinition` + `HueZone`)
// ---------------------------------------------------------------------------

/**
 * Discriminator value for `Zone.zoneType`.
 *
 * - `"logical"` — USB-side region grouping. No bridge interaction; carries
 *   `channelIndices` + optional `region` hint and (optionally) a UI
 *   `borderColor` for the strip badge.
 * - `"hue"` — Hue entertainment area subset. Owns `entertainmentAreaId`,
 *   center coordinates and per-axis scale; channels referencing this
 *   zone via `HueChannelPlacement.zoneId` are resolved as
 *   `world = center + scale * zoneRelativePosition`.
 */
export const ZONE_TYPES = {
  LOGICAL: "logical",
  HUE: "hue",
} as const;

export type ZoneType = (typeof ZONE_TYPES)[keyof typeof ZONE_TYPES];

/**
 * Unified zone descriptor (v1.5 W4-F). Single struct with optional Hue-only
 * fields rather than a TS discriminated union — see RFC §1.1 for rationale:
 *
 * - Persisted JSON survives a sloppy migration (extra fields on a `logical`
 *   zone are tolerated, ignored).
 * - Rust mirror maps cleanly to a single struct with `Option<>` fields, no
 *   `#[serde(tag = "zoneType")]` round-trip during the switchover commit.
 * - Frontend disambiguation is one `zone.zoneType === ZONE_TYPES.HUE`
 *   check at the point of use.
 *
 * Backend invariants (enforced in Rust handlers):
 * - `zoneType === "hue"` ⇒ `entertainmentAreaId`, `centerX/Y/Z`, `scaleX/Y/Z`
 *   MUST be populated (else `ZONE_TYPE_INVALID`).
 * - `zoneType === "logical"` ⇒ Hue-only fields MUST be absent or undefined
 *   (else `ZONE_TYPE_INVALID`).
 *
 * Coordinate system (when `zoneType === "hue"`): same Hue native space as
 * `HueChannelPlacement` — `centerX/Y/Z` and `scaleX/Y/Z` are in `[-1, 1]`.
 *
 * `borderColor` is a UI hint shared by both types; the runtime sampler
 * never reads it.
 */
export interface Zone {
  /** Stable id used by `HueChannelPlacement.zoneId`. */
  id: string;
  /** Human-readable label shown in the zone editor. */
  name: string;
  /** Discriminator — drives badge selection + backend validation branch. */
  zoneType: ZoneType;
  /**
   * Channel indices assigned to this zone.
   * - `zoneType === "hue"` ⇒ entertainment-area channel indices (0-based,
   *   bounded by the bridge's per-area cap).
   * - `zoneType === "logical"` ⇒ USB-side LED indices grouped under this
   *   region. May be empty (zone exists for region tagging only).
   */
  channelIndices: number[];
  /**
   * Parent entertainment area id (one Hue zone never spans two areas).
   * Required when `zoneType === "hue"`, undefined for `"logical"` zones.
   */
  entertainmentAreaId?: string;
  /** Zone center X in Hue native space ([-1, 1]). Hue-only. */
  centerX?: number;
  /** Zone center Y in Hue native space ([-1, 1]). Hue-only. */
  centerY?: number;
  /** Zone center Z in Hue native space ([-1, 1]). Hue-only. */
  centerZ?: number;
  /** Per-axis zone-to-world scale. `1.0` ⇒ zone covers full Hue space. Hue-only. */
  scaleX?: number;
  /** Per-axis zone-to-world scale. Hue-only. */
  scaleY?: number;
  /** Per-axis zone-to-world scale. Hue-only. */
  scaleZ?: number;
  /**
   * Logical zone region hint (USB region-assignment system).
   * Logical-only — Hue zones express position via center/scale instead.
   */
  region?: string;
  /**
   * Optional UI hint for the zone outline color. Drives the dashed bounds
   * box (Hue zones), the strip badge tint (logical zones), and the channel
   * ring rendered by `HueChannelOverlay`. Both zone types render the same
   * amber Rev 07 fallback when absent.
   */
  borderColor?: string;
  /**
   * @deprecated v1.5 — collapsed onto `borderColor` (legacy `HueZone`
   * field). Kept on the contract so previously persisted configs
   * deserialise without loss; new authoring flows must NOT write this
   * field.
   */
  centerColor?: string;
}

// ---------------------------------------------------------------------------
// Legacy zone shapes (v1.5 W4-F migration shim — read-only fallbacks)
// ---------------------------------------------------------------------------

/**
 * @deprecated v1.5 W4-F — superseded by `Zone` with `zoneType: "logical"`.
 * Kept as a type so `toLogicalZone` can convert legacy persisted records
 * during the one-shot `schemaVersion: 1 → 2` migration.
 */
export interface ZoneDefinition {
  id: string;
  name: string;
  /** Channel indices assigned to this zone */
  channelIndices: number[];
  /** Zone region hint (maps to region assignment system) */
  region?: string;
}

/**
 * @deprecated v1.5 W4-F — superseded by `Zone` with `zoneType: "hue"`.
 * Kept as a type so `toHueZone` can convert legacy persisted records
 * during the one-shot `schemaVersion: 1 → 2` migration. Re-exported with
 * the legacy structural shape from W1-A1.
 */
export interface HueZone {
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

// ---------------------------------------------------------------------------
// Migration helpers (v1.5 W4-F — pure functions, wire-up lands in F6)
// ---------------------------------------------------------------------------

/**
 * Internal helper — guards a legacy persisted record against the most common
 * corruption shapes seen in plaintext on-disk JSON: `null`, non-object,
 * `Array.isArray`, missing fields. Centralised so both legacy converters
 * reuse the same gate.
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
 * Convert a legacy `ZoneDefinition` (USB-side region grouping) into a
 * unified `Zone` with `zoneType === "logical"`. Pure function — safe to
 * call in any context.
 *
 * Used by the `schemaVersion 1 → 2` migration shim that lands in F6.
 * This helper is exported here (and not inside `loadShellState`) so the
 * migration is testable in isolation.
 *
 * Returns `null` and emits `console.warn` when the input fails the minimal
 * shape gate (non-object, missing/empty `id` or `name`, non-array
 * `channelIndices`). Migration callers MUST filter `null` results so corrupt
 * records are dropped instead of corrupting the unified `zones[]`. RFC §7 #1.
 */
export function toLogicalZone(legacy: ZoneDefinition): Zone | null {
  if (!isPlainLegacyRecord(legacy)) {
    console.warn(
      "[LumaSync] migration: dropping corrupt ZoneDefinition (not a plain object)",
      legacy,
    );
    return null;
  }

  const id = legacy.id;
  const name = legacy.name;
  const channelIndices = legacy.channelIndices;

  if (typeof id !== "string" || id.length === 0) {
    console.warn("[LumaSync] migration: dropping corrupt ZoneDefinition (missing id)", legacy);
    return null;
  }
  if (typeof name !== "string" || name.length === 0) {
    console.warn(
      "[LumaSync] migration: dropping corrupt ZoneDefinition (missing name)",
      legacy,
    );
    return null;
  }
  if (!Array.isArray(channelIndices)) {
    console.warn(
      "[LumaSync] migration: dropping corrupt ZoneDefinition (channelIndices not an array)",
      legacy,
    );
    return null;
  }

  return {
    id,
    name,
    zoneType: ZONE_TYPES.LOGICAL,
    channelIndices,
    region: legacy.region,
  };
}

/**
 * Convert a legacy `HueZone` into a unified `Zone` with
 * `zoneType === "hue"`. Pure function — safe to call in any context.
 *
 * Used by the `schemaVersion 1 → 2` migration shim that lands in F6.
 * The `centerColor` deprecated field is intentionally dropped on the
 * way through; the migration shim's behaviour matches the W1-A1 v1.5
 * deprecation note (new authoring never writes it, old reads tolerated).
 *
 * Returns `null` and emits `console.warn` when the input fails the Hue
 * shape gate (non-object, missing/empty `id` / `name` / `entertainmentAreaId`,
 * non-finite `centerX/Y/Z` or `scaleX/Y/Z`, non-array `channelIndices`).
 * Migration callers MUST filter `null` results. RFC §7 #1.
 */
export function toHueZone(legacy: HueZone): Zone | null {
  if (!isPlainLegacyRecord(legacy)) {
    console.warn(
      "[LumaSync] migration: dropping corrupt HueZone (not a plain object)",
      legacy,
    );
    return null;
  }

  const id = legacy.id;
  const name = legacy.name;
  const entertainmentAreaId = legacy.entertainmentAreaId;
  const channelIndices = legacy.channelIndices;

  if (typeof id !== "string" || id.length === 0) {
    console.warn("[LumaSync] migration: dropping corrupt HueZone (missing id)", legacy);
    return null;
  }
  if (typeof name !== "string" || name.length === 0) {
    console.warn("[LumaSync] migration: dropping corrupt HueZone (missing name)", legacy);
    return null;
  }
  if (typeof entertainmentAreaId !== "string" || entertainmentAreaId.length === 0) {
    console.warn(
      "[LumaSync] migration: dropping corrupt HueZone (missing entertainmentAreaId)",
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
      "[LumaSync] migration: dropping corrupt HueZone (non-finite center coordinates)",
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
      "[LumaSync] migration: dropping corrupt HueZone (non-finite scale)",
      legacy,
    );
    return null;
  }
  if (!Array.isArray(channelIndices)) {
    console.warn(
      "[LumaSync] migration: dropping corrupt HueZone (channelIndices not an array)",
      legacy,
    );
    return null;
  }

  return {
    id,
    name,
    zoneType: ZONE_TYPES.HUE,
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
// Zone command surface (v1.5 W4-F — moved out of `hue.ts > HUE_ZONE_COMMANDS`)
// ---------------------------------------------------------------------------

/**
 * Authoring commands for `Zone[]`. Backend dispatch branches on
 * `zone.zoneType` so a single command surface covers both logical and
 * Hue zones — no parallel `create_logical_zone` / `create_hue_zone`
 * pair is required.
 *
 * The previous `HUE_ZONE_COMMANDS` map (v1.5 W1-A2) is preserved as a
 * `@deprecated` re-export inside `hue.ts` pointing at THESE values, so
 * the call sites in `RoomMapEditor.tsx` and `LightsSection.tsx` keep
 * compiling until F2/F3/F4 sweep them. The Rust handler list catches
 * up in F5; both sides become green together at the end of PR #1.
 */
export const ZONE_COMMANDS = {
  CREATE_ZONE: "create_zone",
  UPDATE_ZONE: "update_zone",
  DELETE_ZONE: "delete_zone",
  ASSIGN_CHANNEL_TO_ZONE: "assign_channel_to_zone",
} as const;

export type ZoneCommandId = (typeof ZONE_COMMANDS)[keyof typeof ZONE_COMMANDS];

// ---------------------------------------------------------------------------
// Zone status codes (v1.5 W4-F — renamed from `HUE_ZONE_*` to `ZONE_*`)
// ---------------------------------------------------------------------------

/**
 * Status codes emitted by the four zone authoring commands. Replaces the
 * v1.5 W1-A2 `HUE_ZONE_*` family in `hue.ts > HUE_STATUS`. The codes
 * carry the `ZONE_*` prefix because zones are no longer Hue-exclusive
 * (a `zoneType === "logical"` rejection still uses these codes).
 *
 * Two new codes (vs. the W1-A2 baseline):
 * - `ZONE_TYPE_INVALID` — the zone failed the type-shape contract (Hue
 *   zone missing required field, logical zone carrying Hue-only fields).
 * - `ZONE_CONVERSION_OK` — the F4 "duplicate as logical" path succeeded;
 *   distinguished from `ZONE_CREATED` so the UI can show a "duplicated
 *   as logical" toast separate from the generic "zone added" toast.
 *
 * The remaining 6 are mechanical renames (`HUE_ZONE_X` → `ZONE_X`) and
 * narrow which `zoneType` may emit them — see RFC §2.2.
 */
export const ZONE_STATUS_CODES = {
  /** `create_zone` succeeded; the new zone id is in the payload. */
  ZONE_CREATED: "ZONE_CREATED",
  /** `update_zone` succeeded; the mutated zone is in the payload. */
  ZONE_UPDATED: "ZONE_UPDATED",
  /** `delete_zone` succeeded; channels formerly in the zone fall back to legacy absolute placement (Hue) or unassigned (logical). */
  ZONE_DELETED: "ZONE_DELETED",
  /** Referenced zone id does not exist in the active room map. */
  ZONE_NOT_FOUND: "ZONE_NOT_FOUND",
  /**
   * Zone-relative position is outside the [-1, 1] cube on at least one
   * axis. Emitted only when `zoneType === "hue"` — logical zones do not
   * own zone-relative coordinates.
   */
  ZONE_CHANNEL_OUT_OF_BOUNDS: "ZONE_CHANNEL_OUT_OF_BOUNDS",
  /**
   * Per-area bridge channel cap (Hue: 10 per area) reached. Emitted only
   * when `zoneType === "hue"` — logical zones have no bridge cap, so a
   * 12-LED USB strip's logical zone never trips this code.
   */
  ZONE_LIMIT_REACHED: "ZONE_LIMIT_REACHED",
  /**
   * Tried to assign a channel that lives in a different entertainment
   * area than the zone's `entertainmentAreaId`. Emitted only when
   * `zoneType === "hue"`; logical zones have no `entertainmentAreaId`,
   * so the area check is skipped entirely.
   */
  ZONE_CHANNEL_NOT_IN_AREA: "ZONE_CHANNEL_NOT_IN_AREA",
  /**
   * Zone scale exceeds the room or undershoots the slider floor (per-axis
   * `[0.05, 1.0]` clamp). Emitted only when `zoneType === "hue"`. See
   * v1.5 W4-I notes — the previous uniform aspect-ratio lock was dropped,
   * zones are authored as physical 1:1 metric squares, so a non-square
   * room deliberately writes asymmetric `scaleX` / `scaleY`.
   */
  ZONE_OVERSIZED: "ZONE_OVERSIZED",
  /**
   * v1.5 W4-F (new) — rejection when a `zoneType: "hue"` zone is missing
   * `entertainmentAreaId` / center / scale, OR a `zoneType: "logical"`
   * zone carries Hue-only fields populated with non-default values.
   * Distinct from `ZONE_NOT_FOUND` (id resolution) — this is a
   * type-shape contract violation surfaced before the persist.
   */
  ZONE_TYPE_INVALID: "ZONE_TYPE_INVALID",
  /**
   * v1.5 W4-F (new) — F4 "convert hue → logical" duplicate succeeded.
   * Status differs from `ZONE_CREATED` so the UI can show a
   * "duplicated as logical" toast distinct from the generic "zone added"
   * toast. The new logical zone id is in the payload alongside the
   * original Hue zone id (so the UI can flash both).
   */
  ZONE_CONVERSION_OK: "ZONE_CONVERSION_OK",
} as const;

export type ZoneStatusCode =
  (typeof ZONE_STATUS_CODES)[keyof typeof ZONE_STATUS_CODES];

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
 * v1.5 W4-F: `zones` was widened from `ZoneDefinition[]` to `Zone[]`. The
 * legacy `hueZones?: HueZone[]` field stays on the contract as a
 * `@deprecated` read-only fallback so the F6 migration shim can detect
 * leftover plaintext-on-disk states from in-development W1-A1 builds.
 * New code paths MUST NOT write `hueZones` — write into the unified
 * `zones[]` with `zoneType: "hue"` instead.
 */
export interface RoomMapConfig {
  dimensions: RoomDimensions;
  hueChannels: HueChannelPlacement[];
  usbStrips: UsbStripPlacement[];
  furniture: FurniturePlacement[];
  tvAnchor?: TvAnchorPlacement;
  /**
   * Unified zone list (v1.5 W4-F). Replaces both `ZoneDefinition[]` and
   * the deprecated `hueZones?: HueZone[]` field below; disambiguate via
   * `zone.zoneType` at the point of use.
   */
  zones: Zone[];
  /**
   * @deprecated v1.5 W4-F — read-only fallback during migration shim
   * window. The F6 migration converts these into `zones[]` entries with
   * `zoneType: "hue"` and strips the field on next save. New code paths
   * MUST NOT write here; logical and Hue zones share `zones[]`.
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
