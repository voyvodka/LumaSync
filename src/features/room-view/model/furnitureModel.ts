// Which model each piece is drawn as. Free of three.js, so the room map's inspector can say what
// "Auto" reads as without loading the 3D view.
import {
  FURNITURE_VARIANTS,
  type FurniturePlacement,
  type FurnitureTone,
  type FurnitureVariant,
  type RoomMapConfig,
  resolveFurnitureTone,
  resolveFurnitureType,
  resolveFurnitureVariant,
  resolveScreenKind,
  SCREEN_KINDS,
  type ScreenKind,
} from "@/shared/contracts/roomMap";

import { tvMountHeight } from "./roomSpace";

/** How a piece is drawn. The stored type says little on its own — a "table" is a desk under the
 *  screen and a coffee table in front of a sofa, a "sofa" 0.8 m wide is an armchair — so unless the
 *  user picked a model, it is read from the piece's size and what stands around it, as a person
 *  reads a floor plan. */
export type FurnitureModel =
  | { kind: "upholstered"; seats: number; arms: boolean; corner: "left" | "right" | null }
  | { kind: "diningChair" }
  | { kind: "officeChair" }
  | { kind: "bench" }
  /** `screenX`: where the screen stands along the desk, in its frame; null on a desk's return. */
  | { kind: "desk"; screenX: number | null }
  | { kind: "coffeeTable" }
  | { kind: "sideTable"; round: boolean }
  | { kind: "diningTable" }
  | { kind: "cabinet"; doors: number }
  | { kind: "bookshelf" }
  | { kind: "wardrobe" }
  | { kind: "nightstand" }
  | { kind: "tvUnit" }
  | { kind: "bed" }
  | { kind: "plant"; style: "topiary" | "leafy" | "palm" }
  | { kind: "rug"; round: boolean }
  | { kind: "box" };

/** Where a seat stops being a chair and becomes an armchair; also the narrowest piece with arms. */
const ARMCHAIR_MIN_WIDTH = 0.62;
/** A seat cushion's width; a sofa gets as many as fit between its arms. */
const SEAT_WIDTH = 0.62;
const MAX_SEATS = 5;
const SIDE_TABLE_MAX_SIDE = 0.65;
const COFFEE_TABLE_MAX_AREA = 1.6;
/** How far from a sofa a low table still reads as its coffee table. */
const COFFEE_TABLE_REACH = 1.8;
/** How close a table must stand to a desk to read as its return (an L desk). */
const DESK_RETURN_GAP = 0.08;
/** How close a small chair must stand to a desk to read as its office chair. */
const OFFICE_CHAIR_REACH = 1.0;
/** A screen whose bottom edge is lower than this is not standing on a desk. */
const MONITOR_MIN_BOTTOM = 0.55;
export const DESK_TOP = 0.755;

interface Rect {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

function centreOf(item: FurniturePlacement): { x: number; y: number } {
  return { x: item.x + item.width / 2, y: item.y + item.height / 2 };
}

/** The footprint's bounding box in room metres, rotation included. */
function boundsOf(item: FurniturePlacement): Rect {
  const { x, y } = centreOf(item);
  const a = ((item.rotation ?? 0) * Math.PI) / 180;
  const hw = (Math.abs(Math.cos(a)) * item.width + Math.abs(Math.sin(a)) * item.height) / 2;
  const hh = (Math.abs(Math.sin(a)) * item.width + Math.abs(Math.cos(a)) * item.height) / 2;
  return { x0: x - hw, x1: x + hw, y0: y - hh, y1: y + hh };
}

function gapBetween(a: Rect, b: Rect): number {
  const gx = Math.max(0, a.x0 - b.x1, b.x0 - a.x1);
  const gy = Math.max(0, a.y0 - b.y1, b.y0 - a.y1);
  return Math.hypot(gx, gy);
}

/** A room point in the piece's own frame: x across its width, y across its depth. */
function toLocal(item: FurniturePlacement, px: number, py: number): { x: number; y: number } {
  const c = centreOf(item);
  const a = (-(item.rotation ?? 0) * Math.PI) / 180;
  const dx = px - c.x;
  const dy = py - c.y;
  return { x: dx * Math.cos(a) - dy * Math.sin(a), y: dx * Math.sin(a) + dy * Math.cos(a) };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

export const armWidth = (width: number) => clamp(width * 0.085, 0.1, 0.2);

/** An L needs room for its chaise beside the back run; a smaller piece is built straight, in the
 *  3D room and on the plan alike. */
export const cornerFits = (width: number, depth: number) => depth >= 1.3 && width >= 1.6;

function seating(width: number, corner: "left" | "right" | null = null): FurnitureModel {
  const arms = width >= ARMCHAIR_MIN_WIDTH;
  const inner = width - 2 * (arms ? armWidth(width) : 0);
  return { kind: "upholstered", seats: clamp(Math.round(inner / SEAT_WIDTH), 1, MAX_SEATS), arms, corner };
}

interface ScreenSpot {
  x: number;
  y: number;
  bottom: number;
}

function screenSpot(config: RoomMapConfig): ScreenSpot | null {
  const tv = config.tvAnchor;
  if (!tv) return null;
  const height = tv.width * 0.5625;
  return {
    x: tv.x + tv.width / 2,
    y: tv.y + tv.height / 2,
    bottom: tvMountHeight(tv, config.dimensions) - height / 2,
  };
}

/** True when the screen stands over this table — monitor height above it, its centre over the top. */
function screenOver(table: FurniturePlacement, screen: ScreenSpot | null, monitor: boolean): number | null {
  if (!screen || (!monitor && screen.bottom < MONITOR_MIN_BOTTOM)) return null;
  const local = toLocal(table, screen.x, screen.y);
  if (Math.abs(local.x) <= table.width / 2 + 0.05 && Math.abs(local.y) <= table.height / 2 + 0.3) {
    return clamp(local.x, -table.width / 2, table.width / 2);
  }
  return null;
}

/** Reads every piece's model: the user's pick when there is one, else its size and neighbours. */
export function classifyFurniture(config: RoomMapConfig): Map<string, FurnitureModel> {
  const models = new Map<string, FurnitureModel>();
  const items = config.furniture;
  const screen = screenSpot(config);
  const monitor = resolveScreenKind(config.tvAnchor?.screenKind) === SCREEN_KINDS.MONITOR;
  const typed = items.map((item) => ({ item, type: resolveFurnitureType(item.type), variant: resolveFurnitureVariant(item) }));

  const sofas = typed
    .filter(({ item, type }) => type === "sofa" || (type === "chair" && item.width > ARMCHAIR_MIN_WIDTH && item.height >= 0.45))
    .map(({ item }) => item);

  for (const { item, type, variant } of typed) {
    if (type !== "sofa") continue;
    const corner = variant === FURNITURE_VARIANTS.CORNER_LEFT ? "left" : variant === FURNITURE_VARIANTS.CORNER_RIGHT ? "right" : null;
    models.set(item.id, seating(item.width, corner));
  }

  // Tables: an explicit pick first, then the reading — desks before their returns, so a return
  // can find the desk it touches.
  const desks: FurniturePlacement[] = [];
  const tables = typed.filter(({ type }) => type === "table");
  for (const { item, variant } of tables) {
    if (variant === FURNITURE_VARIANTS.DESK) {
      models.set(item.id, { kind: "desk", screenX: screenOver(item, screen, true) });
      desks.push(item);
    } else if (variant === FURNITURE_VARIANTS.COFFEE) {
      models.set(item.id, { kind: "coffeeTable" });
    } else if (variant === FURNITURE_VARIANTS.DINING) {
      models.set(item.id, { kind: "diningTable" });
    } else if (variant === FURNITURE_VARIANTS.SIDE) {
      models.set(item.id, { kind: "sideTable", round: Math.abs(item.width - item.height) < 0.12 });
    }
  }
  for (const { item } of tables) {
    if (models.has(item.id)) continue;
    const screenX = screenOver(item, screen, monitor);
    if (screenX !== null) {
      models.set(item.id, { kind: "desk", screenX });
      desks.push(item);
    }
  }
  for (const { item } of tables) {
    if (models.has(item.id)) continue;
    if (desks.some((desk) => gapBetween(boundsOf(item), boundsOf(desk)) <= DESK_RETURN_GAP)) {
      models.set(item.id, { kind: "desk", screenX: null });
      desks.push(item);
    }
  }
  for (const { item } of tables) {
    if (models.has(item.id)) continue;
    if (Math.max(item.width, item.height) <= SIDE_TABLE_MAX_SIDE) {
      models.set(item.id, { kind: "sideTable", round: Math.abs(item.width - item.height) < 0.12 });
      continue;
    }
    const c = centreOf(item);
    const nearSofa = sofas.some((s) => {
      const sc = centreOf(s);
      return Math.hypot(sc.x - c.x, sc.y - c.y) <= COFFEE_TABLE_REACH;
    });
    models.set(
      item.id,
      nearSofa && item.width * item.height <= COFFEE_TABLE_MAX_AREA ? { kind: "coffeeTable" } : { kind: "diningTable" },
    );
  }

  for (const { item, type, variant } of typed) {
    switch (type) {
      case "chair":
        models.set(item.id, chairModel(item, variant, desks));
        break;
      case "storage":
        models.set(item.id, storageModel(item, variant, screen));
        break;
      case "bed":
        models.set(item.id, { kind: "bed" });
        break;
      case "plant":
        models.set(item.id, {
          kind: "plant",
          style: variant === FURNITURE_VARIANTS.LEAFY ? "leafy" : variant === FURNITURE_VARIANTS.PALM ? "palm" : "topiary",
        });
        break;
      case "rug":
        models.set(item.id, {
          kind: "rug",
          round:
            variant === FURNITURE_VARIANTS.ROUND ||
            (variant === undefined && Math.abs(item.width - item.height) < 0.1),
        });
        break;
      case "other":
        models.set(item.id, { kind: "box" });
        break;
      default:
        break;
    }
  }
  return models;
}

function chairModel(item: FurniturePlacement, variant: FurnitureVariant | undefined, desks: readonly FurniturePlacement[]): FurnitureModel {
  switch (variant) {
    case FURNITURE_VARIANTS.DINING:
      return { kind: "diningChair" };
    case FURNITURE_VARIANTS.OFFICE:
      return { kind: "officeChair" };
    case FURNITURE_VARIANTS.ARMCHAIR:
      return { kind: "upholstered", seats: 1, arms: true, corner: null };
    case FURNITURE_VARIANTS.BENCH:
      return { kind: "bench" };
    default:
      break;
  }
  if (item.width <= ARMCHAIR_MIN_WIDTH && item.height >= 0.3) {
    const atDesk = desks.some((desk) => gapBetween(boundsOf(item), boundsOf(desk)) <= OFFICE_CHAIR_REACH);
    return { kind: atDesk ? "officeChair" : "diningChair" };
  }
  return item.height < 0.45 ? { kind: "bench" } : seating(item.width);
}

/** Longer than this, storage with no pick reads as wardrobes rather than a sideboard. */
const STORAGE_RUN_MIN = 2.4;

function storageModel(item: FurniturePlacement, variant: FurnitureVariant | undefined, screen: ScreenSpot | null): FurnitureModel {
  switch (variant) {
    case FURNITURE_VARIANTS.SIDEBOARD:
      return { kind: "cabinet", doors: clamp(Math.round(item.width / 0.45), 1, 6) };
    case FURNITURE_VARIANTS.BOOKSHELF:
      return { kind: "bookshelf" };
    case FURNITURE_VARIANTS.WARDROBE:
      return { kind: "wardrobe" };
    case FURNITURE_VARIANTS.NIGHTSTAND:
      return { kind: "nightstand" };
    case FURNITURE_VARIANTS.TV_UNIT:
      return { kind: "tvUnit" };
    default:
      break;
  }
  if (Math.max(item.width, item.height) <= 0.6) return { kind: "nightstand" };
  if (screen) {
    const local = toLocal(item, screen.x, screen.y);
    if (Math.abs(local.x) <= item.width / 2 && Math.abs(local.y) <= item.height / 2 + 0.4) return { kind: "tvUnit" };
  }
  if (Math.min(item.width, item.height) <= 0.36) return { kind: "bookshelf" };
  // A run of storage longer than a sideboard is a wall of wardrobes, not a 4 m console.
  if (Math.max(item.width, item.height) > STORAGE_RUN_MIN) return { kind: "wardrobe" };
  return { kind: "cabinet", doors: clamp(Math.round(item.width / 0.45), 1, 6) };
}

/** What the screen reads as with no pick: a monitor when a desk stands under it, else a TV. */
export function autoScreenKind(config: RoomMapConfig): ScreenKind {
  if (!config.tvAnchor) return SCREEN_KINDS.TV;
  const unpicked = { ...config, tvAnchor: { ...config.tvAnchor, screenKind: undefined } };
  const deskUnder = [...classifyFurniture(unpicked).values()].some((m) => m.kind === "desk" && m.screenX !== null);
  return deskUnder ? SCREEN_KINDS.MONITOR : SCREEN_KINDS.TV;
}

/** The variant a model reads as, for the inspector's "Auto · …" — null when it has no name of its
 *  own among the type's choices. */
export function autoVariant(model: FurnitureModel): FurnitureVariant | null {
  switch (model.kind) {
    case "upholstered":
      if (model.corner === "left") return FURNITURE_VARIANTS.CORNER_LEFT;
      if (model.corner === "right") return FURNITURE_VARIANTS.CORNER_RIGHT;
      return model.seats === 1 && model.arms ? FURNITURE_VARIANTS.ARMCHAIR : FURNITURE_VARIANTS.STRAIGHT;
    case "diningChair":
      return FURNITURE_VARIANTS.DINING;
    case "officeChair":
      return FURNITURE_VARIANTS.OFFICE;
    case "bench":
      return FURNITURE_VARIANTS.BENCH;
    case "desk":
      return FURNITURE_VARIANTS.DESK;
    case "coffeeTable":
      return FURNITURE_VARIANTS.COFFEE;
    case "sideTable":
      return FURNITURE_VARIANTS.SIDE;
    case "diningTable":
      return FURNITURE_VARIANTS.DINING;
    case "cabinet":
      return FURNITURE_VARIANTS.SIDEBOARD;
    case "bookshelf":
      return FURNITURE_VARIANTS.BOOKSHELF;
    case "wardrobe":
      return FURNITURE_VARIANTS.WARDROBE;
    case "nightstand":
      return FURNITURE_VARIANTS.NIGHTSTAND;
    case "tvUnit":
      return FURNITURE_VARIANTS.TV_UNIT;
    case "plant":
      return model.style === "leafy" ? FURNITURE_VARIANTS.LEAFY : model.style === "palm" ? FURNITURE_VARIANTS.PALM : FURNITURE_VARIANTS.TOPIARY;
    case "rug":
      return model.round ? FURNITURE_VARIANTS.ROUND : FURNITURE_VARIANTS.RECTANGLE;
    default:
      return null;
  }
}

/** The model's own height: the top of what it is, for `topMeters`' placeholder and scaling. */
export function modelTop(model: FurnitureModel): number {
  switch (model.kind) {
    case "upholstered":
      return model.arms ? 0.84 : 0.79;
    case "diningChair":
      return 0.89;
    case "officeChair":
      return 1.0;
    case "bench":
      return 0.5;
    case "desk":
      return DESK_TOP;
    case "coffeeTable":
      return 0.43;
    case "sideTable":
      return 0.55;
    case "diningTable":
      return 0.75;
    case "cabinet":
      return 0.805;
    case "bookshelf":
      return 1.8;
    case "wardrobe":
      return 2.0;
    case "nightstand":
      return 0.55;
    case "tvUnit":
      return 0.46;
    case "bed":
      return 0.99;
    case "plant":
      return model.style === "palm" ? 1.6 : model.style === "leafy" ? 0.9 : 1.15;
    case "rug":
      return 0.012;
    case "box":
      return 0.75;
  }
}

/** The height of the surface a piece offers on top, for what stands on it. */
export function surfaceTop(model: FurnitureModel): number {
  switch (model.kind) {
    case "upholstered":
    case "diningChair":
    case "officeChair":
      return 0.45;
    case "bed":
      return 0.55;
    case "plant":
    case "rug":
      return 0;
    default:
      return modelTop(model);
  }
}

/** How dark the soft contact shadow under a piece is: a closed base shades the floor, legs barely. */
export function contactShade(model: FurnitureModel): number {
  switch (model.kind) {
    case "upholstered":
    case "cabinet":
    case "wardrobe":
    case "bookshelf":
    case "tvUnit":
    case "bed":
    case "box":
      return 0.42;
    case "officeChair":
    case "sideTable":
    case "plant":
      return 0.2;
    case "rug":
      return 0.12;
    default:
      return 0.26;
  }
}

/** Each tone's base colour (0xRRGGBB): the inspector's swatches and the 3D materials read the same
 *  numbers, so a swatch is the colour the piece takes. */
export const FURNITURE_TONE_COLORS = {
  slate: 0x55657d,
  caramel: 0xb57f4b,
  sage: 0x7d8b78,
  charcoal: 0x3c3f45,
  cream: 0xd9cfbf,
  brick: 0xa45a43,
  oak: 0xb88d63,
  walnut: 0x6b4a33,
  white: 0xe6e1d8,
  black: 0x2a2a2c,
} satisfies Record<FurnitureTone, number>;

/** A 0xRRGGBB colour as CSS, built at run time so no raw hex sits in the source. */
export function hexCss(colour: number): string {
  return `#${colour.toString(16).padStart(6, "0")}`;
}

/** A tone as a CSS colour. */
export function toneCss(tone: FurnitureTone): string {
  return hexCss(FURNITURE_TONE_COLORS[tone]);
}

const FABRIC_TONES: ReadonlySet<FurnitureTone> = new Set(["slate", "caramel", "sage", "charcoal", "cream", "brick"]);

/** What a piece is made of: its upholstery (a plant's pot, a rug's weave) and its wood, and whether
 *  the wood is the user's tone rather than the default oak. The 3D room shades these into its
 *  materials and the plan fills with them, so a piece is one colour in both. */
export interface FurnitureColours {
  fabric: number;
  wood: number;
  woodToned: boolean;
}

export function furnitureColours(item: FurniturePlacement, model: FurnitureModel): FurnitureColours {
  // The model's own colours: one seat with arms reads as an armchair and takes the warm upholstery,
  // a small armless seat is a slipper chair, a sofa stays slate.
  const ownFabric =
    model.kind === "upholstered"
      ? model.arms && model.seats === 1 && model.corner === null
        ? FURNITURE_TONE_COLORS.caramel
        : !model.arms
          ? FURNITURE_TONE_COLORS.sage
          : FURNITURE_TONE_COLORS.slate
      : model.kind === "bed"
        ? FURNITURE_TONE_COLORS.cream
        : model.kind === "rug"
          ? FURNITURE_TONE_COLORS.slate
          : FURNITURE_TONE_COLORS.sage;
  const plain: FurnitureColours = { fabric: ownFabric, wood: FURNITURE_TONE_COLORS.oak, woodToned: false };
  const tone = resolveFurnitureTone(item);
  // A plant's tone is its pot, whichever family the tone comes from.
  if (model.kind === "plant") return { ...plain, fabric: tone === undefined ? FURNITURE_TONE_COLORS.cream : FURNITURE_TONE_COLORS[tone] };
  if (tone === undefined) return plain;
  if (FABRIC_TONES.has(tone)) return { ...plain, fabric: FURNITURE_TONE_COLORS[tone] };
  return { ...plain, wood: FURNITURE_TONE_COLORS[tone], woodToned: true };
}
