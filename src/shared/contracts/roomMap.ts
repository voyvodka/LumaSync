/**
 * Room Map Contracts
 *
 * Types for the 2D room map configuration, Hue channel spatial placements,
 * USB strip placements, furniture, TV anchor, and zone definitions.
 *
 * Hue channel positions use native Hue coordinate space: x/y/z in [-1.0, 1.0].
 * x: -1=left, +1=right
 * y: depth — +1 is the TV wall (drawn at the top of the canvas), -1 behind the viewer
 * z: -1=floor, +1=ceiling
 * See docs/architecture/hue.md for how the runtime maps these onto the screen.
 *
 * The TV anchor is in room metres instead; see `TvAnchorPlacement` for that
 * frame and `RoomGeometry` for how the two are sent together.
 *
 * Zones are Hue-only (docs/architecture/hue.md). `ScreenZone` / `LedZone`
 * will land later as separate types sharing no discriminator with `HueZone`.
 */

import type { HueChannelPlacementOverride } from "./hue";
import type { CommandStatusOf } from "./status";

// ---------------------------------------------------------------------------
// Room Map Commands
// ---------------------------------------------------------------------------

/** Room-map persistence is not on this surface — the config round-trips through
 * the shellStore (`useRoomMapState`), so the only room-map command is the
 * background-image copy, which needs filesystem access the webview lacks. */
export const ROOM_MAP_COMMANDS = {
  COPY_BACKGROUND_IMAGE: "copy_background_image",
} as const;

/** Codes `copy_background_image` rejects with, as the `"CODE: context"` prefix
 *  of its `Err(String)`. Other failures reach the caller uncoded. */
export const ROOM_MAP_BACKGROUND_ERROR = {
  TOO_LARGE: "ROOM_MAP_BACKGROUND_TOO_LARGE",
} as const;

export type RoomMapBackgroundErrorCode =
  (typeof ROOM_MAP_BACKGROUND_ERROR)[keyof typeof ROOM_MAP_BACKGROUND_ERROR];

/** The import limit the UI quotes. A Rust test holds it equal to
 *  `MAX_BACKGROUND_IMAGE_BYTES` in `room_map/background.rs`. */
export const ROOM_MAP_BACKGROUND_MAX_MB = 20;

// ---------------------------------------------------------------------------
// Hue Channel Placement
// ---------------------------------------------------------------------------

/** Zone-relative coordinate in `[-1, 1]` per axis — mirrors Rust's `ZoneRelativePosition`. */
export interface ZoneRelativePosition {
  x: number;
  y: number;
  z: number;
}

/** Where a placement's `z` came from — mirrors Rust's `HueChannelHeightOrigin`.
 * See docs/architecture/room-map.md for why an unknown origin is not "0". */
export const HUE_CHANNEL_HEIGHT_ORIGIN = {
  BRIDGE: "bridge",
  USER: "user",
} as const;

export type HueChannelHeightOrigin =
  (typeof HUE_CHANNEL_HEIGHT_ORIGIN)[keyof typeof HUE_CHANNEL_HEIGHT_ORIGIN];

/** Persisted position of a Hue channel; when `zoneId` is set, `zoneRelativePosition`
 * is authoritative and absolute `x/y/z` are derived from the zone at runtime. */
export interface HueChannelPlacement {
  /** Channel index within the entertainment area (0-based) */
  channelIndex: number;
  /** Parent entertainment area — `channelIndex` is unique only *within* one, so
   *  without this two areas' channel 0 are a single record. Nullable like
   *  `zoneId`: the Rust mirror echoes an absent value back as `null`. Empty ⇒
   *  unscoped, which the 4 → 5 migration leaves only when no area was known. */
  entertainmentAreaId?: string | null;
  /** The bridge's identity; `channelIndex` is our ordinal and coincides with it
   * only on a contiguous area. Absent ⇒ unresolved, and the write-back refuses
   * rather than substituting the ordinal. Nullable: Rust echoes `None` as `null`. */
  channelId?: number | null;
  /** Horizontal position: -1=left wall, +1=right wall */
  x: number;
  /** Vertical position (depth/front-back): -1=back wall, +1=front (TV wall) */
  y: number;
  /** Height: -1=floor, +1=ceiling */
  z: number;
  /** Absent ⇒ unknown: a record from before height was carried, whose `0` may
   * be a placeholder. Nullable: Rust echoes `None` as `null`. */
  zOrigin?: HueChannelHeightOrigin | null;
  /** Optional user-assigned label */
  label?: string | null;
  /** Nullable because the Rust mirror puts `None` on the wire as `null`. */
  locked?: boolean | null;
  /**
   * When present, this channel is logically grouped under the
   * referenced `HueZone`. Absent ⇒ legacy absolute placement.
   */
  zoneId?: string | null;
  /**
   * Zone-relative position in [-1, 1] × [-1, 1] × [-1, 1]
   * coordinates. Authoritative when `zoneId` is set; ignored otherwise.
   * The world-space `x/y/z` above are derived from this via
   * `HueZone.center + HueZone.scale * zoneRelativePosition`.
   */
  zoneRelativePosition?: ZoneRelativePosition | null;
  /** The plan direction a one-sided light throws its light, in degrees clockwise with 0 toward the
   *  plan's top (the TV wall, Hue `y=+1`) — `FurniturePlacement.rotation`'s frame. Absent ⇒ turned to
   *  its nearest wall. Drawing only: the stream and room-aware sampling never read it. Read through
   *  `resolveHueFacing`. */
  facing?: number | null;
  /** The fixture the room draws in place of the one the bridge's archetype names — a plain bulb in
   *  a lamp the bridge cannot know about. Absent ⇒ from the bridge. Read through `resolveHueFixture`. */
  fixture?: HueFixture | null;
}

/** The fixtures the 3D room draws a Hue light as. */
export const HUE_FIXTURES = {
  PLAY_BAR: "playBar",
  LIGHTSTRIP: "lightstrip",
  FLOOR_LAMP: "floorLamp",
  SIGNE: "signe",
  TABLE_LAMP: "tableLamp",
  PENDANT: "pendant",
  CEILING: "ceiling",
  GO: "go",
  IRIS: "iris",
  BLOOM: "bloom",
  SPOT: "spot",
  WALL: "wall",
  TUBE: "tube",
  BULB: "bulb",
} as const;

export type HueFixture = (typeof HUE_FIXTURES)[keyof typeof HUE_FIXTURES];

const HUE_FIXTURE_VALUES = new Set<string>(Object.values(HUE_FIXTURES));

/** The stored fixture when it is a known one, else none (from the bridge); a newer build's stays stored. */
export function resolveHueFixture(channel: HueChannelPlacement): HueFixture | undefined {
  const fixture: unknown = channel.fixture;
  return typeof fixture === "string" && HUE_FIXTURE_VALUES.has(fixture) ? (fixture as HueFixture) : undefined;
}

/** The stored facing in [0, 360) when it is a number, else none (turned to its nearest wall). */
export function resolveHueFacing(channel: HueChannelPlacement): number | undefined {
  const facing: unknown = channel.facing;
  return typeof facing === "number" && Number.isFinite(facing) ? ((facing % 360) + 360) % 360 : undefined;
}

/** Never index `hueChannels` by array position — `channelIndex` is bridge-assigned
 * and room maps written by v1.4.0 and earlier are gapped (docs/architecture/room-map.md). */
export function findHueChannel(
  channels: readonly HueChannelPlacement[],
  channelIndex: number,
): HueChannelPlacement | undefined {
  return channels.find((c) => c.channelIndex === channelIndex);
}

/** Swap one placement in place. Matching on `channelIndex` alone would hit the
 *  same-numbered channel in every other area; order is preserved because the
 *  object list is rendered from it and a drag must not reshuffle it. */
export function replaceHueChannel(
  channels: readonly HueChannelPlacement[],
  updated: HueChannelPlacement,
): HueChannelPlacement[] {
  return channels.map((channel) =>
    channel.channelIndex === updated.channelIndex && areaKey(channel) === areaKey(updated)
      ? updated
      : channel,
  );
}

/** `null` and `undefined` both mean unscoped — Rust echoes `None` as `null`. */
function areaKey(channel: HueChannelPlacement): string {
  return channel.entertainmentAreaId ?? "";
}

/** The placements belonging to one entertainment area. An unscoped record — one
 *  the 4 → 5 migration had no `lastHueAreaId` to backfill from — is adopted by
 *  the area currently being viewed rather than stranded where nothing can edit
 *  it. See docs/architecture/room-map.md. */
export function hueChannelsForArea(
  channels: readonly HueChannelPlacement[],
  entertainmentAreaId: string,
): HueChannelPlacement[] {
  return channels.filter((c) => !c.entertainmentAreaId || c.entertainmentAreaId === entertainmentAreaId);
}

/** Fold an edited subset back into the stored list. An editor only sees the
 *  channels one bridge is reporting, so assigning its output wholesale deletes
 *  every placement outside that view — see docs/architecture/room-map.md. */
export function mergeHueChannels(
  stored: readonly HueChannelPlacement[],
  edited: readonly HueChannelPlacement[],
): HueChannelPlacement[] {
  // Area *and* index — index alone is the collision this field exists to stop.
  // Unscoped also loses: `hueChannelsForArea` lent it out and it returns
  // stamped, so a strict match would keep the pre-adoption copy beside it.
  const displaces = (stored: HueChannelPlacement, edit: HueChannelPlacement) =>
    stored.channelIndex === edit.channelIndex &&
    (areaKey(stored) === areaKey(edit) || !stored.entertainmentAreaId);

  return [
    ...stored.filter((channel) => !edited.some((edit) => displaces(channel, edit))),
    ...edited,
  ];
}

// ---------------------------------------------------------------------------
// USB Strip Placement
// ---------------------------------------------------------------------------

export interface UsbStripPlacement {
  /** The placement's own key: unique on the map, the editor's object id and the save-merge key.
   *  Not a `LedStrip.id`, even when the two are equal — the strip a placement draws is the one on
   *  its `portName`. */
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
   * USB serial port the strip is bound to (e.g.
   * `/dev/tty.usbserial-110`). Multiple `UsbStripPlacement` rows can
   * share the same `portName` so a single controller can host
   * multiple physical segments. Optional for backwards compatibility
   * with strips authored before it existed; consumers must treat `undefined`
   * as "not yet linked" and surface a re-pair affordance instead of
   * blocking the user.
   */
  portName?: string;
  /** The strip's height above the floor in metres; absent ⇒ at the skirting. Drawing-only: Rust
   *  reads a strip's id and port alone. Read through `resolveStripMountHeight`. */
  mountHeightMeters?: number | null;
  /** The tape's LEDs per metre; set, the strip's drawn length follows `ledCount` (`fitStripLength`).
   *  Drawing-only, read through `resolveStripDensity`. */
  ledsPerMeter?: number | null;
  /** Where the strip turns between its start and end, in room metres, at most `MAX_STRIP_CORNERS`:
   *  bent round a corner or a desk edge, or folded into a small space. Drawing-only, read through
   *  `resolveStripCorners`; a strip moves through `translateStrip`, which carries them. */
  corners?: RoomCorner[] | null;
}

export const MAX_STRIP_CORNERS = 8;

/** The stored corners when every one is a finite point and there are no more than the cap; any bad
 *  entry reads the strip as straight rather than half-bent. */
export function resolveStripCorners(strip: UsbStripPlacement): RoomCorner[] {
  const stored: unknown = strip.corners;
  if (!Array.isArray(stored) || stored.length === 0 || stored.length > MAX_STRIP_CORNERS) return [];
  const corners: RoomCorner[] = [];
  for (const corner of stored as unknown[]) {
    const { x, y } = (corner ?? {}) as { x?: unknown; y?: unknown };
    if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) return [];
    corners.push({ x, y });
  }
  return corners;
}

/** The strip's run as points: its start, each corner, its end. */
export function stripPoints(strip: UsbStripPlacement): RoomCorner[] {
  return [{ x: strip.startX, y: strip.startY }, ...resolveStripCorners(strip), { x: strip.endX, y: strip.endY }];
}

export function stripRunLength(strip: UsbStripPlacement): number {
  const points = stripPoints(strip);
  let length = 0;
  for (let i = 1; i < points.length; i++) length += Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y);
  return length;
}

/** The middle of the box round the strip's run: where a straight strip's midpoint was. */
export function stripCentre(strip: UsbStripPlacement): RoomCorner {
  const points = stripPoints(strip);
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  return { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 };
}

/** The strip moved whole, its corners with it, each point to the millimetre. */
export function translateStrip<T extends UsbStripPlacement>(strip: T, dx: number, dy: number): T {
  const mm = (v: number) => Math.round(v * 1000) / 1000;
  const corners = resolveStripCorners(strip);
  return {
    ...strip,
    startX: mm(strip.startX + dx),
    startY: mm(strip.startY + dy),
    endX: mm(strip.endX + dx),
    endY: mm(strip.endY + dy),
    ...(corners.length > 0 ? { corners: corners.map((c) => ({ x: mm(c.x + dx), y: mm(c.y + dy) })) } : {}),
  };
}

const MAX_STRIP_DENSITY = 300;

/** The stored density when it is a usable one (finite, 1 to 300 LEDs per metre), else none. */
export function resolveStripDensity(strip: UsbStripPlacement): number | undefined {
  const density: unknown = strip.ledsPerMeter;
  return typeof density === "number" && Number.isFinite(density) && density >= 1 && density <= MAX_STRIP_DENSITY ? density : undefined;
}

/** The strip's length in metres from its LEDs and density, or none without a density. */
export function stripLengthFromDensity(strip: UsbStripPlacement): number | undefined {
  const density = resolveStripDensity(strip);
  return density === undefined ? undefined : strip.ledCount / density;
}

/** The strip with its end moved along its run so it is as long as its LEDs at its density: past its
 *  last corner the last leg grows, short of it the corners beyond the new end go. One with no
 *  density, or no run to follow, comes back as it was. */
export function fitStripLength<T extends UsbStripPlacement>(strip: T): T {
  const length = stripLengthFromDensity(strip);
  const points = stripPoints(strip);
  if (length === undefined || stripRunLength(strip) < 1e-6) return strip;
  const round = (v: number) => Math.round(v * 1000) / 1000;
  let walked = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const leg = Math.hypot(b.x - a.x, b.y - a.y);
    const last = i === points.length - 1;
    if (leg < 1e-6 && !last) continue;
    if (walked + leg >= length || last) {
      // An end left on its last corner has no way of its own; it carries on the way the run came in.
      let from = a;
      for (let j = i - 1; leg < 1e-6 && j > 0; j--) {
        const p = points[j - 1]!;
        if (Math.hypot(a.x - p.x, a.y - p.y) >= 1e-6) {
          from = p;
          break;
        }
      }
      const way = Math.hypot(a.x - from.x, a.y - from.y);
      const dir = leg >= 1e-6 ? { x: (b.x - a.x) / leg, y: (b.y - a.y) / leg } : way >= 1e-6 ? { x: (a.x - from.x) / way, y: (a.y - from.y) / way } : { x: 0, y: 0 };
      const corners = points.slice(1, i);
      return {
        ...strip,
        endX: round(a.x + dir.x * (length - walked)),
        endY: round(a.y + dir.y * (length - walked)),
        ...(resolveStripCorners(strip).length > 0 ? { corners: corners.length > 0 ? corners : null } : {}),
      };
    }
    walked += leg;
  }
  return strip;
}

/** The stored height when it is a usable one (finite, not below the floor), else none. No cap: a
 *  room can be 8 m tall, so the 3D room holds it under its own ceiling. */
export function resolveStripMountHeight(strip: UsbStripPlacement): number | undefined {
  const height: unknown = strip.mountHeightMeters;
  return typeof height === "number" && Number.isFinite(height) && height >= 0 ? height : undefined;
}

// ---------------------------------------------------------------------------
// Furniture Placement
// ---------------------------------------------------------------------------

/** Every kind of piece the room map holds; `other` is a plain box. A value from a newer build reads
 *  as `other` (`resolveFurnitureType`) rather than failing a reader. */
export const FURNITURE_TYPES = {
  SOFA: "sofa",
  TABLE: "table",
  CHAIR: "chair",
  BED: "bed",
  STORAGE: "storage",
  PLANT: "plant",
  RUG: "rug",
  KITCHEN: "kitchen",
  OTHER: "other",
} as const;

export type FurnitureType = (typeof FURNITURE_TYPES)[keyof typeof FURNITURE_TYPES];

/** A model the user picked over the automatic reading of a piece's size and neighbours. Which
 *  types take which is `FURNITURE_CATALOGUE`. */
export const FURNITURE_VARIANTS = {
  STRAIGHT: "straight",
  CORNER_LEFT: "cornerLeft",
  CORNER_RIGHT: "cornerRight",
  DINING: "dining",
  OFFICE: "office",
  ARMCHAIR: "armchair",
  BENCH: "bench",
  DESK: "desk",
  COFFEE: "coffee",
  SIDE: "side",
  SIDEBOARD: "sideboard",
  BOOKSHELF: "bookshelf",
  WARDROBE: "wardrobe",
  NIGHTSTAND: "nightstand",
  TV_UNIT: "tvUnit",
  TOPIARY: "topiary",
  LEAFY: "leafy",
  PALM: "palm",
  RECTANGLE: "rectangle",
  ROUND: "round",
  STOOL: "stool",
  BEANBAG: "beanbag",
  DRESSER: "dresser",
  COUNTER: "counter",
  ISLAND: "island",
  FRIDGE: "fridge",
} as const;

export type FurnitureVariant = (typeof FURNITURE_VARIANTS)[keyof typeof FURNITURE_VARIANTS];

/** One curated palette: fabrics for what is upholstered, woods for what is built. */
export const FURNITURE_TONES = {
  SLATE: "slate",
  CARAMEL: "caramel",
  SAGE: "sage",
  CHARCOAL: "charcoal",
  CREAM: "cream",
  BRICK: "brick",
  OAK: "oak",
  WALNUT: "walnut",
  WHITE: "white",
  BLACK: "black",
} as const;

export type FurnitureTone = (typeof FURNITURE_TONES)[keyof typeof FURNITURE_TONES];

export interface FurnitureKindSpec {
  variants: readonly FurnitureVariant[];
  tones: readonly FurnitureTone[];
}

const V = FURNITURE_VARIANTS;
const FABRIC_TONES = [
  FURNITURE_TONES.SLATE,
  FURNITURE_TONES.CARAMEL,
  FURNITURE_TONES.SAGE,
  FURNITURE_TONES.CHARCOAL,
  FURNITURE_TONES.CREAM,
  FURNITURE_TONES.BRICK,
] as const;
const WOOD_TONES = [FURNITURE_TONES.OAK, FURNITURE_TONES.WALNUT, FURNITURE_TONES.WHITE, FURNITURE_TONES.BLACK] as const;

/** What each type can be drawn as and coloured with. */
export const FURNITURE_CATALOGUE = {
  sofa: { variants: [V.STRAIGHT, V.CORNER_LEFT, V.CORNER_RIGHT], tones: FABRIC_TONES },
  table: { variants: [V.DESK, V.COFFEE, V.DINING, V.SIDE], tones: WOOD_TONES },
  chair: { variants: [V.DINING, V.OFFICE, V.ARMCHAIR, V.BENCH, V.STOOL, V.BEANBAG], tones: FABRIC_TONES },
  bed: { variants: [], tones: FABRIC_TONES },
  storage: { variants: [V.SIDEBOARD, V.BOOKSHELF, V.WARDROBE, V.NIGHTSTAND, V.TV_UNIT, V.DRESSER], tones: WOOD_TONES },
  plant: { variants: [V.TOPIARY, V.LEAFY, V.PALM], tones: [FURNITURE_TONES.CREAM, FURNITURE_TONES.BRICK, FURNITURE_TONES.CHARCOAL, FURNITURE_TONES.WHITE] },
  rug: { variants: [V.RECTANGLE, V.ROUND], tones: FABRIC_TONES },
  kitchen: { variants: [V.COUNTER, V.ISLAND, V.FRIDGE], tones: WOOD_TONES },
  other: { variants: [], tones: WOOD_TONES },
} satisfies Record<FurnitureType, FurnitureKindSpec>;

export interface FurniturePlacement {
  id: string;
  type: FurnitureType;
  /** Top-left corner of the unrotated footprint, in room metres; `rotation` turns it about its
   *  centre. */
  x: number;
  y: number;
  width: number;
  /** Footprint depth along y, in metres — not the piece's height (`topMeters`). */
  height: number;
  /** Rotation in degrees (0-360) */
  rotation?: number;
  label?: string;
  locked?: boolean;
  /** Absent ⇒ the model is read from the piece's size and neighbours. One the type does not take
   *  reads as absent and is kept as stored, so a newer build's choice survives an edit here. */
  variant?: FurnitureVariant;
  /** Absent ⇒ the model's own colour. Kept as stored when the type does not take it, as above. */
  tone?: FurnitureTone;
  /** Top of the piece above the floor, in metres. Absent ⇒ the model's own height. */
  topMeters?: number;
}

const FURNITURE_TYPE_VALUES = new Set<string>(Object.values(FURNITURE_TYPES));

/** The stored type as a known one; anything else (a newer build's kind) reads as `other`. */
export function resolveFurnitureType(stored: unknown): FurnitureType {
  return typeof stored === "string" && FURNITURE_TYPE_VALUES.has(stored)
    ? (stored as FurnitureType)
    : FURNITURE_TYPES.OTHER;
}

/** The stored variant when the piece's type takes it, else none. */
export function resolveFurnitureVariant(item: FurniturePlacement): FurnitureVariant | undefined {
  const variants: readonly string[] = FURNITURE_CATALOGUE[resolveFurnitureType(item.type)].variants;
  return item.variant !== undefined && variants.includes(item.variant) ? item.variant : undefined;
}

/** The tallest piece the room map draws; a stored height past it is out of reach of any room. */
const MAX_FURNITURE_TOP_METRES = 3;

/** The stored height when it is a usable one (finite, above the floor, under the cap), else none. */
export function resolveFurnitureTop(item: FurniturePlacement): number | undefined {
  const top: unknown = item.topMeters;
  return typeof top === "number" && Number.isFinite(top) && top > 0 && top <= MAX_FURNITURE_TOP_METRES ? top : undefined;
}

/** The stored tone when the piece's type takes it, else none. */
export function resolveFurnitureTone(item: FurniturePlacement): FurnitureTone | undefined {
  const tones: readonly string[] = FURNITURE_CATALOGUE[resolveFurnitureType(item.type)].tones;
  return item.tone !== undefined && tones.includes(item.tone) ? item.tone : undefined;
}

// ---------------------------------------------------------------------------
// TV Anchor Placement
// ---------------------------------------------------------------------------

/** The TV's placement, used as the spatial anchor for channel/strip positions.
 * Room-metre frame, the one the editor draws in: origin at the corner where the
 * TV wall meets the left wall, +x toward the right wall, +y away from the TV
 * wall (canvas down), +z up from the floor. */
export interface TvAnchorPlacement {
  /** Top-left corner of the footprint rectangle, in metres — not its centre. */
  x: number;
  y: number;
  /** Footprint width along x, in metres. */
  width: number;
  /** Footprint depth along y, in metres. Not the screen's height. */
  height: number;
  locked?: boolean;
  /** Screen centre above the floor, in metres. Absent ⇒ 40% of the room height,
   * resolved at runtime rather than written, so it follows a room-height edit. */
  mountHeightMeters?: number;
  /** Absent ⇒ a monitor when a desk stands under it, else a TV. Frontend-only: never mirrored in
   * Rust, which reads the anchor's place and mount height alone. */
  screenKind?: ScreenKind;
}

/** What the captured screen is drawn as. */
export const SCREEN_KINDS = {
  TV: "tv",
  MONITOR: "monitor",
} as const;

export type ScreenKind = (typeof SCREEN_KINDS)[keyof typeof SCREEN_KINDS];

const SCREEN_KIND_VALUES = new Set<string>(Object.values(SCREEN_KINDS));

/** The stored screen kind when it is a known one, else none (Auto). */
export function resolveScreenKind(stored: unknown): ScreenKind | undefined {
  return typeof stored === "string" && SCREEN_KIND_VALUES.has(stored) ? (stored as ScreenKind) : undefined;
}

/** Mirrors `DEFAULT_TV_MOUNT_HEIGHT_FRACTION` in `commands/room_affinity.rs`;
 * `verify:shell-contracts` fails if the two drift. */
export const DEFAULT_TV_MOUNT_HEIGHT_FRACTION = 0.4;

// ---------------------------------------------------------------------------
// Room Dimensions
// ---------------------------------------------------------------------------

/** Physical room dimensions in meters, used to scale the room-map editor. */
export interface RoomDimensions {
  /** Width in meters */
  widthMeters: number;
  /** Depth in meters */
  depthMeters: number;
  /** Height in meters (ceiling) */
  heightMeters: number;
}

/** A corner of the room's outline on the plan, in metres from the top-left (y down from the TV wall). */
export interface RoomCorner {
  x: number;
  y: number;
}

/** How far a stored corner may sit off the room's edge, or off its wall's line, and still be read. */
const ROOM_FOOTPRINT_TOLERANCE_M = 0.001;
/** The shortest wall an outline may have. */
export const ROOM_FOOTPRINT_MIN_WALL_M = 0.1;

const rectangleOf = ({ widthMeters: w, depthMeters: d }: RoomDimensions): RoomCorner[] => [
  { x: 0, y: 0 },
  { x: w, y: 0 },
  { x: w, y: d },
  { x: 0, y: d },
];

/** Whether two axis-aligned walls share any point, ends included. */
function wallsMeet(a: RoomCorner, b: RoomCorner, c: RoomCorner, d: RoomCorner): boolean {
  const overlap = (p1: number, p2: number, q1: number, q2: number) =>
    Math.max(Math.min(p1, p2), Math.min(q1, q2)) <= Math.min(Math.max(p1, p2), Math.max(q1, q2));
  return overlap(a.x, b.x, c.x, d.x) && overlap(a.y, b.y, c.y, d.y);
}

/**
 * The room's outline: a stored footprint when it is a usable orthogonal polygon — 4, 6 or 8
 * corners, walls that turn at every corner and are at least 10 cm long, no wall touching another
 * but its neighbours, and a bounding box that is exactly the room's dimensions — else the plain
 * rectangle. Never scaled to fit and never written back: a footprint that disagrees with the
 * dimensions is ignored rather than trusted, since `dimensions` is what Rust samples the room by.
 * The answer is snapped onto its walls and the room's edges, walks with the room on its right and
 * starts at the top-left-most corner, so every reading of one shape is the same list.
 */
export function resolveRoomFootprint(config: Pick<RoomMapConfig, "footprint" | "dimensions">): RoomCorner[] {
  const rectangle = rectangleOf(config.dimensions);
  const stored: unknown = config.footprint;
  if (!Array.isArray(stored) || ![4, 6, 8].includes(stored.length)) return rectangle;
  const raw: RoomCorner[] = [];
  for (const corner of stored as unknown[]) {
    const { x, y } = (corner ?? {}) as { x?: unknown; y?: unknown };
    if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) return rectangle;
    raw.push({ x, y });
  }
  const n = raw.length;
  const tol = ROOM_FOOTPRINT_TOLERANCE_M;
  const at = (i: number) => raw[((i % n) + n) % n]!;

  // Each wall is level or plumb and turns at its end; its length is judged once it is snapped.
  const level: boolean[] = [];
  for (let i = 0; i < n; i++) {
    const a = at(i);
    const b = at(i + 1);
    const flat = Math.abs(a.y - b.y) <= tol;
    const upright = Math.abs(a.x - b.x) <= tol;
    if (flat === upright) return rectangle;
    level.push(flat);
  }
  for (let i = 0; i < n; i++) if (level[i] === level[(i + 1) % n]) return rectangle;

  // Onto the walls' lines: a corner takes its level wall's y and its plumb wall's x — onto the
  // room's edge when within the tolerance, else to the millimetre — so reading the answer again
  // gives the same numbers.
  const place = (value: number, edge: number) =>
    Math.abs(value) <= tol ? 0 : Math.abs(value - edge) <= tol ? edge : Math.round(value * 1000) / 1000;
  const { widthMeters: w, depthMeters: d } = config.dimensions;
  const corners = raw.map((_, i) => {
    const incoming = i - 1;
    const levelIn = level[(incoming + n) % n];
    const flatWall = levelIn ? [at(incoming), at(i)] : [at(i), at(i + 1)];
    const plumbWall = levelIn ? [at(i), at(i + 1)] : [at(incoming), at(i)];
    const y = (flatWall[0]!.y + flatWall[1]!.y) / 2;
    const x = (plumbWall[0]!.x + plumbWall[1]!.x) / 2;
    return { x: place(x, w), y: place(y, d) };
  });

  // On the snapped corners, so an answer read again is judged by the same lengths.
  for (let i = 0; i < n; i++) {
    const a = corners[i]!;
    const b = corners[(i + 1) % n]!;
    if (Math.abs(a.x - b.x) + Math.abs(a.y - b.y) < ROOM_FOOTPRINT_MIN_WALL_M - 1e-9) return rectangle;
  }

  const xs = corners.map((c) => c.x);
  const ys = corners.map((c) => c.y);
  if (Math.min(...xs) !== 0 || Math.max(...xs) !== w || Math.min(...ys) !== 0 || Math.max(...ys) !== d) return rectangle;

  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      if (wallsMeet(corners[i]!, corners[(i + 1) % n]!, corners[j]!, corners[(j + 1) % n]!)) return rectangle;
    }
  }

  let area2 = 0;
  for (let i = 0; i < n; i++) {
    const a = corners[i]!;
    const b = corners[(i + 1) % n]!;
    area2 += a.x * b.y - b.x * a.y;
  }
  const walk = area2 > 0 ? corners : [...corners].reverse();
  let start = 0;
  for (let i = 1; i < n; i++) {
    const c = walk[i]!;
    const s = walk[start]!;
    if (c.y < s.y || (c.y === s.y && c.x < s.x)) start = i;
  }
  return [...walk.slice(start), ...walk.slice(0, start)];
}

// ---------------------------------------------------------------------------
// Room Geometry (ambilight worker input)
// ---------------------------------------------------------------------------

/** What the ambilight worker needs to sample by room position. A wire projection
 * derived from `RoomMapConfig` at dispatch time and never persisted; present only
 * while a TV anchor exists, which is the room-aware gate. `dimensions` and `tv`
 * are in the room-metre frame documented on `TvAnchorPlacement`. */
export interface RoomGeometry {
  dimensions: RoomDimensions;
  tv: TvAnchorPlacement;
  /** The same projection the stream start carries (`toChannelPlacements`), sent
   * again because the stream's copy is fixed at stream start and a drag must
   * reach the running worker without restarting the stream. */
  huePlacements: HueChannelPlacementOverride[];
}

// ---------------------------------------------------------------------------
// Hue Zone (the sole surviving zone kind, a Hue Entertainment Area
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
  borderColor?: string | null;
  /**
   * @deprecated v1.5 — collapsed onto `borderColor` after manual testing
   * showed the dual-color affordance was confusing. Kept on the contract
   * so previously persisted configs deserialise without loss; new
   * authoring flows MUST NOT write this field.
   */
  centerColor?: string | null;
}

// ---------------------------------------------------------------------------
// Legacy zone shapes (migration shim — read-only fallbacks)
// ---------------------------------------------------------------------------

/**
 * @deprecated Read-only legacy migration shape. The original `HueZone`
 * interface (before the short-lived zone unification) had the same
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
 * @deprecated Read-only legacy migration shape. The older USB-side
 * region grouping. A short-lived zone unification tried to
 * promote this into a generic `Zone & { zoneType: "logical" }`; the
 * reversal dropped the concept entirely. The interface survives only so
 * the migration shim can detect previously persisted records and DROP
 * them with a `console.warn`. New code paths MUST NOT consume this type.
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
// Migration helpers (pure functions consumed by the `1 → 2` migration)
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
 * Convert a `LegacyHueZone` (the older persisted shape, structurally
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
 * `zones[]` array.
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
// Hue Zone command surface (Hue-only; the short-lived generic
// `ZONE_COMMANDS` map is replaced 1:1 by the renamed Hue-only map below).
// ---------------------------------------------------------------------------

/**
 * Authoring commands for `HueZone[]`. Backend dispatch is single-branch
 * (no `zoneType` discriminator). The four
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
// Hue Zone status codes (Hue-only, renamed from the short-lived generic
// `ZONE_*` family back to `HUE_ZONE_*`).
// ---------------------------------------------------------------------------

/**
 * Status codes emitted by the four Hue zone authoring commands. These
 * codes are Hue-only — the short-lived `ZONE_TYPE_INVALID` and
 * `ZONE_CONVERSION_OK` codes (which only made sense in a logical/Hue
 * discriminated world) are gone.
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
   * `[0.05, 1.0]` clamp). The previous uniform
   * aspect-ratio lock was dropped, zones are authored as physical 1:1
   * metric squares, so a non-square room deliberately writes asymmetric
   * `scaleX` / `scaleY`.
   */
  HUE_ZONE_OVERSIZED: "HUE_ZONE_OVERSIZED",
} as const;

export type HueZoneStatusCode =
  (typeof HUE_ZONE_STATUS_CODES)[keyof typeof HUE_ZONE_STATUS_CODES];

// The four commands signal a refusal by *resolving* with a non-applied code —
// they reject only on IPC-transport failure, so a caller holding just a
// `.catch()` cannot see a validation refusal at all.
const HUE_ZONE_SUCCESS_CODES = new Set<string>([
  HUE_ZONE_STATUS_CODES.HUE_ZONE_CREATED,
  HUE_ZONE_STATUS_CODES.HUE_ZONE_UPDATED,
  HUE_ZONE_STATUS_CODES.HUE_ZONE_DELETED,
]);

/** True when a Hue zone command applied the mutation it was asked to apply. */
export function isHueZoneApplied(code: HueZoneStatusCode): boolean {
  return HUE_ZONE_SUCCESS_CODES.has(code);
}

// ---------------------------------------------------------------------------
// Hue Zone command payloads (mirrors `commands/room_map/hue_zone.rs`)
// ---------------------------------------------------------------------------

/** Response for the four Hue zone authoring commands. `zones`/`channels` are the applied
 *  mutation on success and the pre-image on a refusal — only while callers send
 *  *pre*-mutation lists. See docs/architecture/room-map.md. */
export interface HueZoneCommandResult {
  status: CommandStatusOf<HueZoneStatusCode>;
  zones: HueZone[];
  channels: HueChannelPlacement[];
}

/** Payload for `create_hue_zone`. */
export interface CreateHueZoneRequest {
  zone: HueZone;
  existingZones?: HueZone[];
}

/** Payload for `update_hue_zone`. */
export interface UpdateHueZoneRequest {
  zone: HueZone;
  existingZones?: HueZone[];
}

/** Payload for `delete_hue_zone`. */
export interface DeleteHueZoneRequest {
  zoneId: string;
  existingZones?: HueZone[];
  channels?: HueChannelPlacement[];
}

/** Payload for `assign_channel_to_hue_zone`. */
export interface AssignChannelRequest {
  channelIndex: number;
  /** `null` detaches the channel back to legacy absolute placement. */
  zoneId: string | null;
  zoneRelativePosition: ZoneRelativePosition | null;
  entertainmentAreaId: string;
  existingZones?: HueZone[];
  channels?: HueChannelPlacement[];
}

/** Channel-position write-back to the bridge (`room_map/save_load.rs`). i18n keys
 * live under `hue:runtime.writeback.codes.*` in both locales. */
export const CHANNEL_WRITEBACK_STATUS = {
  SCHEMA_REJECTED: "CHAN_WB_SCHEMA_REJECTED",
  NETWORK_ERROR: "CHAN_WB_NETWORK_ERROR",
  /** Area id failed the path-traversal guard before any request was built. */
  AREA_INVALID: "HUE_AREA_INVALID",
  /** The bridge answered 404 for the area: deleted in the Hue app, or an id
   * from another bridge. Nothing was written; re-selecting an area fixes it,
   * retrying does not. */
  AREA_NOT_FOUND: "CHAN_WB_AREA_NOT_FOUND",
  /** Nothing could be written: no placement had a `channelId`, or none mapped
   * onto a single bridge position (a gradient segment, a grouped channel). A
   * skipped placement is never addressed by its ordinal or approximated. When
   * some can be written they are, and the response is
   * `HUE_CHANNEL_POSITIONS_UPDATED` with the skipped ones named in `details` —
   * one unwritable marker must not block syncing the rest. */
  UNRESOLVED_CHANNEL: "CHAN_WB_UNRESOLVED_CHANNEL",
} as const;

export type ChannelWritebackStatusCode =
  (typeof CHANNEL_WRITEBACK_STATUS)[keyof typeof CHANNEL_WRITEBACK_STATUS];

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
 * `zones: HueZone[]` is the single Hue-only zone array (a unified
 * discriminator was rolled back — docs/architecture/hue.md). The legacy
 * `hueZones?: LegacyHueZone[]` field stays on the contract as a
 * `@deprecated` read-only fallback so the `1 → 2` migration can fold
 * leftover on-disk states from in-development builds. New code paths MUST
 * NOT write `hueZones` — write into `zones[]` instead.
 */
export interface RoomMapConfig {
  dimensions: RoomDimensions;
  hueChannels: HueChannelPlacement[];
  usbStrips: UsbStripPlacement[];
  furniture: FurniturePlacement[];
  tvAnchor?: TvAnchorPlacement;
  /**
   * Hue zone list (Hue-only after the direction reversal).
   * Each entry is a `HueZone`; logical / screen / LED zones are NOT
   * stored here and will land later in their own arrays.
   */
  zones: HueZone[];
  /**
   * @deprecated Read-only fallback during the migration shim window. The
   * `1 → 2` migration converts these into `zones[]: HueZone[]`
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
  /** The room's outline when it is not the plain rectangle of `dimensions` (an L, U or T); read
   *  through `resolveRoomFootprint`. The editor's alone: Rust samples the room by `dimensions`. A
   *  writer deletes the key for the plain rectangle, and changes it and `dimensions` in one apply. */
  footprint?: RoomCorner[];
  /** What the room is finished in — its floor and walls — for the 3D view alone; absent ⇒ oak and
   *  warm white. Read through `resolveRoomSurfaces`; a writer spreads the stored value, so a newer
   *  build's choice survives an edit of the other. */
  surfaces?: RoomSurfaces;
  /** The room's own build — columns, beams, windows, doors, niches and the ceiling's own lights — for
   *  the plan and the 3D view alone; Rust carries it untouched, so nothing in it is ever streamed.
   *  Read through `resolveRoomStructures`, which skips a kind or an entry this build cannot draw and
   *  never writes back; an edit goes by id on the stored array, so those survive it. A
   *  resize moves every entry's `x`/`y` and `x1`…`y2` by name, an unknown kind's too: a kind keeps
   *  its plan points under those names and gives them no other meaning. */
  structures?: RoomStructure[];
}

/** The floor's finish, as one choice: a wood or parquet, carpet, a tile or concrete. The keys' order
 *  is Room settings' order, light to dark with the woods first; nothing stores an index. */
export const FLOOR_FINISHES = {
  OAK: "oak",
  WALNUT: "walnut",
  ASH: "ash",
  HERRINGBONE: "herringbone",
  CARPET: "carpet",
  TILE_LIGHT: "tileLight",
  TILE_DARK: "tileDark",
  CHECKER: "checker",
  TERRACOTTA: "terracotta",
  CONCRETE: "concrete",
} as const;
export type FloorFinish = (typeof FLOOR_FINISHES)[keyof typeof FLOOR_FINISHES];

/** The walls' paint, from a named palette the lights read against. The keys' order is Room
 *  settings' order, light to dark. */
export const WALL_COLORS = {
  WARM_WHITE: "warmWhite",
  COOL_WHITE: "coolWhite",
  GREIGE: "greige",
  BLUSH: "blush",
  SAGE: "sage",
  CLAY: "clay",
  OCHRE: "ochre",
  FOREST: "forest",
  NAVY: "navy",
  CHARCOAL: "charcoal",
} as const;
export type WallColor = (typeof WALL_COLORS)[keyof typeof WALL_COLORS];

export interface RoomSurfaces {
  /** Absent, or a finish this build does not know (kept as stored) ⇒ oak. */
  floor?: FloorFinish;
  /** Absent, or a colour this build does not know (kept as stored) ⇒ warm white. */
  walls?: WallColor;
}

const FLOOR_FINISH_VALUES = new Set<string>(Object.values(FLOOR_FINISHES));
const WALL_COLOR_VALUES = new Set<string>(Object.values(WALL_COLORS));

/** The room's surfaces as this build draws them: every field filled, anything unknown read as the
 *  default. Read-only — it never writes back what it does not know. */
export function resolveRoomSurfaces(config: Pick<RoomMapConfig, "surfaces">): Required<RoomSurfaces> {
  const stored: { floor?: unknown; walls?: unknown } = config.surfaces ?? {};
  return {
    floor: typeof stored.floor === "string" && FLOOR_FINISH_VALUES.has(stored.floor) ? (stored.floor as FloorFinish) : FLOOR_FINISHES.OAK,
    walls: typeof stored.walls === "string" && WALL_COLOR_VALUES.has(stored.walls) ? (stored.walls as WallColor) : WALL_COLORS.WARM_WHITE,
  };
}

// ---------------------------------------------------------------------------
// Room structures
// ---------------------------------------------------------------------------

export const STRUCTURE_KINDS = {
  COLUMN: "column",
  BEAM: "beam",
  WINDOW: "window",
  DOOR: "door",
  NICHE: "niche",
  LIGHT: "light",
} as const;
export type StructureKind = (typeof STRUCTURE_KINDS)[keyof typeof STRUCTURE_KINDS];

export interface StructureBase {
  id: string;
  label?: string;
  locked?: boolean;
}

/** Standing on the floor up to the ceiling; `x`/`y` its centre, `width` × `depth` its footprint. */
export interface ColumnStructure extends StructureBase {
  kind: typeof STRUCTURE_KINDS.COLUMN;
  x: number;
  y: number;
  width: number;
  depth: number;
  /** Degrees clockwise on the plan, as a piece of furniture turns. */
  rotation?: number;
  /** Absent ⇒ square. */
  shape?: "square" | "round";
}

/** Under the ceiling from one end to the other, `dropMeters` deep. */
export interface BeamStructure extends StructureBase {
  kind: typeof STRUCTURE_KINDS.BEAM;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  width: number;
  dropMeters: number;
}

/** Set in a wall: `x`/`y` its middle, read onto the nearest wall, and `width` along it. */
interface WallItemBase extends StructureBase {
  x: number;
  y: number;
  width: number;
}

export interface WindowStructure extends WallItemBase {
  kind: typeof STRUCTURE_KINDS.WINDOW;
  sillMeters: number;
  heightMeters: number;
}

export interface DoorStructure extends WallItemBase {
  kind: typeof STRUCTURE_KINDS.DOOR;
  heightMeters: number;
  /** As seen from inside the room. */
  hinge: "left" | "right";
  swing: "in" | "out";
}

export interface NicheStructure extends WallItemBase {
  kind: typeof STRUCTURE_KINDS.NICHE;
  bottomMeters: number;
  heightMeters: number;
  /** Into the wall, behind its face. */
  depth: number;
}

/** The ceiling's own fixtures a decor light can be: its own set, so a fixture added for Hue lights
 *  does not widen it unseen. */
export const DECOR_LIGHT_FIXTURES = {
  PENDANT: HUE_FIXTURES.PENDANT,
  CEILING: HUE_FIXTURES.CEILING,
  SPOT: HUE_FIXTURES.SPOT,
  BULB: HUE_FIXTURES.BULB,
} as const satisfies Record<string, HueFixture>;
export type DecorLightFixture = (typeof DECOR_LIGHT_FIXTURES)[keyof typeof DECOR_LIGHT_FIXTURES];

/** A light the house has and LumaSync does not drive: drawn lit in the 3D room, never streamed. */
export interface LightStructure extends StructureBase {
  kind: typeof STRUCTURE_KINDS.LIGHT;
  x: number;
  y: number;
  fixture: DecorLightFixture;
  /** Below the ceiling; absent ⇒ where the fixture hangs. */
  dropMeters?: number;
  /** Absent ⇒ 2700; read within `SOLID_KELVIN_RANGE`. */
  kelvin?: number;
}

export const DECOR_LIGHT_KELVIN = 2700;

export type RoomStructure = ColumnStructure | BeamStructure | WindowStructure | DoorStructure | NicheStructure | LightStructure;
export type WallStructure = WindowStructure | DoorStructure | NicheStructure;

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Fallback room dimensions used before the user customises them. */
export const DEFAULT_ROOM_DIMENSIONS: RoomDimensions = {
  widthMeters: 5,
  depthMeters: 4,
  heightMeters: 2.5,
};

/** Empty room map config used to seed a fresh install. */
export const DEFAULT_ROOM_MAP: RoomMapConfig = {
  dimensions: DEFAULT_ROOM_DIMENSIONS,
  hueChannels: [],
  usbStrips: [],
  furniture: [],
  zones: [],
  imageLayers: [],
};
