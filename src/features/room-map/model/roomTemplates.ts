import type { TFunction } from "i18next";

import type { TranslationKey } from "@/features/i18n/catalogue";
import type {
  FurniturePlacement,
  FurnitureType,
  FurnitureVariant,
  RoomMapConfig,
  RoomStructure,
  TvAnchorPlacement,
  UsbStripPlacement,
} from "@/shared/contracts/roomMap";
import { DEFAULT_ROOM_MAP } from "@/shared/contracts/roomMap";

import type { HueSpot } from "./hueSpots";
import { STRUCTURE_NAME_KEYS } from "./roomStructures";

export interface RoomTemplate {
  id: string;
  nameKey: TranslationKey;
  descKey: TranslationKey;
  config: (t: TFunction) => RoomMapConfig;
  hueSpots?: readonly HueSpot[];
}

function makeTemplate(
  overrides: Partial<RoomMapConfig> & { tvAnchor?: TvAnchorPlacement; furniture?: FurniturePlacement[]; usbStrips?: UsbStripPlacement[] },
): RoomMapConfig {
  return { ...DEFAULT_ROOM_MAP, ...overrides };
}

/** A showroom piece, named by its model so each one can be told apart in the list. */
function shown(
  t: TFunction,
  type: FurnitureType,
  variant: FurnitureVariant | null,
  x: number,
  y: number,
  width: number,
  height: number,
  rotation = 0,
): FurniturePlacement {
  return {
    id: `show-${type}-${variant ?? "plain"}`,
    type,
    x,
    y,
    width,
    height,
    rotation,
    label: variant ? t(`roomMap:furniture.variant.${variant}`) : t(`roomMap:furniture.type.${type}`),
    ...(variant ? { variant } : {}),
  };
}

/** Every structure the room can be built with, on the walls and in the free end past the furniture. */
function showroomStructures(t: TFunction): RoomStructure[] {
  const label = (kind: RoomStructure["kind"]) => t(STRUCTURE_NAME_KEYS[kind]);
  return [
    { id: "show-beam", kind: "beam", label: label("beam"), x1: 10, y1: 0, x2: 10, y2: 8, width: 0.25, dropMeters: 0.3 },
    { id: "show-column-square", kind: "column", label: label("column"), x: 10.9, y: 4.6, width: 0.4, depth: 0.4 },
    { id: "show-column-round", kind: "column", label: label("column"), x: 11.6, y: 6.6, width: 0.36, depth: 0.36, shape: "round" },
    { id: "show-window-left", kind: "window", label: label("window"), x: 0, y: 4.0, width: 1.2, sillMeters: 0.9, heightMeters: 1.2 },
    { id: "show-window-back", kind: "window", label: label("window"), x: 8.9, y: 8, width: 1.6, sillMeters: 0.8, heightMeters: 1.3 },
    { id: "show-door-back", kind: "door", label: label("door"), x: 11.4, y: 8, width: 0.9, heightMeters: 2.05, hinge: "right", swing: "in" },
    { id: "show-door-right", kind: "door", label: label("door"), x: 12.5, y: 1.6, width: 0.9, heightMeters: 2.05, hinge: "left", swing: "out" },
    { id: "show-niche", kind: "niche", label: label("niche"), x: 12.5, y: 4.4, width: 0.8, bottomMeters: 0.5, heightMeters: 1.1, depth: 0.25 },
    { id: "show-light-living", kind: "light", label: label("light"), x: 4.1, y: 2.2, fixture: "ceiling" },
    { id: "show-light-dining", kind: "light", label: label("light"), x: 1.1, y: 5.05, fixture: "pendant" },
    { id: "show-light-kitchen-1", kind: "light", label: label("light"), x: 0.7, y: 7.1, fixture: "spot", kelvin: 3000 },
    { id: "show-light-kitchen-2", kind: "light", label: label("light"), x: 1.4, y: 7.1, fixture: "spot", kelvin: 3000 },
    { id: "show-light-kitchen-3", kind: "light", label: label("light"), x: 2.1, y: 7.1, fixture: "spot", kelvin: 3000 },
    { id: "show-light-bulb", kind: "light", label: label("light"), x: 11.4, y: 3.0, fixture: "bulb", kelvin: 2200 },
  ];
}

/** Every type and every model it takes, in rows facing the TV wall like a shop floor, and every
 *  structure past them. */
function showroom(t: TFunction): RoomMapConfig {
  const s = (type: FurnitureType, variant: FurnitureVariant | null, x: number, y: number, w: number, h: number) => shown(t, type, variant, x, y, w, h);
  // A piece's front is its plan top: one backed onto the TV wall is turned round to face the room.
  const onTvWall = (type: FurnitureType, variant: FurnitureVariant, x: number, w: number, h: number) => shown(t, type, variant, x, 0, w, h, 180);
  return makeTemplate({
    dimensions: { widthMeters: 12.5, depthMeters: 8, heightMeters: 2.7 },
    structures: showroomStructures(t),
    tvAnchor: { x: 3.6, y: 0.12, width: 1.4, height: 0.08 },
    usbStrips: [
      { stripId: "usb-tv", startX: 3.7, startY: 0.1, endX: 4.9, endY: 0.1, ledCount: 60 },
      { stripId: "usb-wall", startX: 12.49, startY: 2.4, endX: 12.49, endY: 3.9, ledCount: 90, mountHeightMeters: 1.2 },
    ],
    // Rugs first, so the plan draws them under what stands near them.
    furniture: [
      s("rug", "rectangle", 5.0, 4.6, 2.0, 1.4),
      s("rug", "round", 7.3, 4.6, 1.4, 1.4),
      onTvWall("storage", "bookshelf", 0.2, 1.0, 0.32),
      onTvWall("storage", "sideboard", 1.4, 1.6, 0.45),
      onTvWall("storage", "tvUnit", 3.3, 2.0, 0.45),
      onTvWall("storage", "dresser", 5.6, 1.0, 0.5),
      onTvWall("storage", "wardrobe", 6.9, 2.0, 0.6),
      onTvWall("storage", "nightstand", 9.2, 0.45, 0.4),
      s("sofa", "straight", 0.3, 1.2, 2.1, 0.9),
      s("sofa", "cornerLeft", 2.8, 1.2, 2.6, 1.6),
      s("sofa", "cornerRight", 5.8, 1.2, 2.6, 1.6),
      s("chair", "dining", 0.3, 3.3, 0.5, 0.5),
      s("chair", "office", 1.1, 3.3, 0.6, 0.6),
      s("chair", "armchair", 2.0, 3.3, 0.85, 0.85),
      s("chair", "bench", 3.2, 3.3, 1.2, 0.4),
      s("chair", "stool", 4.7, 3.3, 0.4, 0.4),
      s("chair", "beanbag", 5.4, 3.3, 0.9, 0.9),
      s("table", "desk", 6.6, 3.3, 1.4, 0.7),
      s("table", "coffee", 8.3, 3.3, 1.1, 0.6),
      s("table", "dining", 0.3, 4.6, 1.6, 0.9),
      s("table", "side", 2.2, 4.6, 0.5, 0.5),
      s("bed", null, 3.0, 4.6, 1.6, 2.05),
      s("plant", "topiary", 7.6, 6.2, 0.5, 0.5),
      s("plant", "leafy", 8.3, 6.2, 0.6, 0.6),
      s("plant", "palm", 9.1, 6.2, 0.7, 0.7),
      s("kitchen", "counter", 0.2, 7.38, 2.4, 0.62),
      s("kitchen", "fridge", 2.7, 7.32, 0.7, 0.68),
      s("kitchen", "island", 5.0, 6.6, 1.8, 0.9),
      s("other", null, 7.2, 7.2, 0.6, 0.6),
    ],
  });
}

/** A template's piece, named by its model, or its type where it has none. */
function piece(
  t: TFunction,
  id: string,
  type: FurnitureType,
  variant: FurnitureVariant | null,
  x: number,
  y: number,
  width: number,
  height: number,
  rotation = 0,
): FurniturePlacement {
  return { ...shown(t, type, variant, x, y, width, height, rotation), id };
}

type WallItem = { x: number; y: number; width: number };

function rooms(t: TFunction) {
  const label = (kind: RoomStructure["kind"]) => t(STRUCTURE_NAME_KEYS[kind]);
  return {
    window: (id: string, at: WallItem, sillMeters = 0.9, heightMeters = 1.3): RoomStructure => ({ id, kind: "window", label: label("window"), ...at, sillMeters, heightMeters }),
    door: (id: string, at: WallItem, hinge: "left" | "right", swing: "in" | "out" = "in"): RoomStructure => ({ id, kind: "door", label: label("door"), ...at, heightMeters: 2.05, hinge, swing }),
    light: (id: string, x: number, y: number, fixture: "ceiling" | "pendant" | "spot" | "bulb", kelvin?: number): RoomStructure => ({
      id,
      kind: "light",
      label: label("light"),
      x,
      y,
      fixture,
      ...(kelvin !== undefined ? { kelvin } : {}),
    }),
  };
}

// Pieces stand at their real sizes, a sofa about 3 m from a 55" screen; rugs come first so the plan
// draws them under what stands on them, and a piece backed onto the TV wall is turned to face the room.
function livingRoom(t: TFunction): RoomMapConfig {
  const r = rooms(t);
  return makeTemplate({
    dimensions: { widthMeters: 4.4, depthMeters: 3.8, heightMeters: 2.6 },
    tvAnchor: { x: 1.59, y: 0.06, width: 1.22, height: 0.08, mountHeightMeters: 1.0, screenKind: "tv", backlightStripId: "usb-tv" },
    usbStrips: [{ stripId: "usb-tv", startX: 1.64, startY: 0.05, endX: 2.76, endY: 0.05, ledCount: 60 }],
    furniture: [
      piece(t, "rug-1", "rug", "rectangle", 1.2, 1.45, 2.0, 1.4),
      piece(t, "tv-unit", "storage", "tvUnit", 1.2, 0, 2.0, 0.42, 180),
      piece(t, "coffee-table", "table", "coffee", 1.7, 1.8, 1.0, 0.5),
      piece(t, "sofa-1", "sofa", "straight", 1.1, 2.8, 2.2, 0.9),
      piece(t, "side-table", "table", "side", 0.5, 3.1, 0.45, 0.45),
      piece(t, "plant-1", "plant", "leafy", 3.75, 0.1, 0.55, 0.55),
    ],
    structures: [
      r.window("window-left", { x: 0, y: 1.6, width: 1.4 }),
      r.door("door-back", { x: 3.85, y: 3.8, width: 0.85 }, "right"),
      r.light("light-ceiling", 2.2, 1.9, "ceiling"),
    ],
  });
}

function deskSetup(t: TFunction): RoomMapConfig {
  const r = rooms(t);
  return makeTemplate({
    dimensions: { widthMeters: 3.2, depthMeters: 3.0, heightMeters: 2.5 },
    tvAnchor: { x: 0.95, y: 0.12, width: 0.71, height: 0.05, mountHeightMeters: 1.05, screenKind: "monitor", backlightStripId: "usb-desk" },
    usbStrips: [{ stripId: "usb-desk", startX: 1.0, startY: 0.1, endX: 1.61, endY: 0.1, ledCount: 30 }],
    furniture: [
      piece(t, "desk-side", "table", "desk", 0, 0, 0.6, 1.3),
      piece(t, "desk-main", "table", "desk", 0.6, 0, 1.4, 0.7),
      piece(t, "chair-1", "chair", "office", 1.0, 0.85, 0.6, 0.6),
      piece(t, "bookshelf", "storage", "bookshelf", 2.05, 2.68, 1.0, 0.32),
      piece(t, "armchair", "chair", "armchair", 0.25, 2.0, 0.85, 0.85),
      piece(t, "plant-1", "plant", "topiary", 2.55, 0.1, 0.5, 0.5),
    ],
    structures: [
      r.window("window-right", { x: 3.2, y: 1.0, width: 1.2 }),
      r.door("door-back", { x: 1.45, y: 3.0, width: 0.85 }, "left"),
      r.light("light-ceiling", 1.6, 1.5, "ceiling"),
    ],
  });
}

function fullRoom(t: TFunction): RoomMapConfig {
  const r = rooms(t);
  return makeTemplate({
    dimensions: { widthMeters: 5.5, depthMeters: 4.6, heightMeters: 2.7 },
    tvAnchor: { x: 2.03, y: 0.07, width: 1.44, height: 0.08, mountHeightMeters: 1.05, screenKind: "tv", backlightStripId: "usb-tv" },
    usbStrips: [{ stripId: "usb-tv", startX: 2.08, startY: 0.06, endX: 3.42, endY: 0.06, ledCount: 90 }],
    furniture: [
      piece(t, "rug-1", "rug", "rectangle", 1.45, 1.4, 2.6, 2.0),
      piece(t, "tv-unit", "storage", "tvUnit", 1.65, 0, 2.2, 0.45, 180),
      piece(t, "bookshelf", "storage", "bookshelf", 0.2, 0, 1.0, 0.32, 180),
      piece(t, "coffee-table", "table", "coffee", 2.2, 1.95, 1.1, 0.6),
      piece(t, "sofa-1", "sofa", "cornerLeft", 1.4, 2.9, 2.6, 1.6),
      piece(t, "armchair", "chair", "armchair", 0.35, 1.6, 0.85, 0.85),
      piece(t, "side-table", "table", "side", 4.15, 3.95, 0.5, 0.5),
      piece(t, "plant-1", "plant", "topiary", 4.85, 0.15, 0.5, 0.5),
      piece(t, "plant-2", "plant", "palm", 4.7, 1.3, 0.7, 0.7),
    ],
    structures: [
      r.window("window-left", { x: 0, y: 3.2, width: 1.6 }),
      r.window("window-right", { x: 5.5, y: 2.8, width: 1.4 }),
      r.door("door-back", { x: 0.75, y: 4.6, width: 0.9 }, "left"),
      r.light("light-ceiling", 2.75, 2.3, "ceiling"),
      r.light("light-reading", 0.8, 2.05, "pendant", 2400),
    ],
  });
}

function gamingCorner(t: TFunction): RoomMapConfig {
  const r = rooms(t);
  return makeTemplate({
    dimensions: { widthMeters: 3.6, depthMeters: 3.2, heightMeters: 2.5 },
    // A 34" ultrawide.
    tvAnchor: { x: 1.4, y: 0.14, width: 0.79, height: 0.06, mountHeightMeters: 1.1, screenKind: "monitor", screenAspect: "21:9", backlightStripId: "usb-desk" },
    usbStrips: [{ stripId: "usb-desk", startX: 1.44, startY: 0.12, endX: 2.15, endY: 0.12, ledCount: 45 }],
    furniture: [
      piece(t, "rug-1", "rug", "round", 1.2, 0.55, 1.4, 1.4),
      piece(t, "desk-main", "table", "desk", 1.0, 0, 1.6, 0.75),
      piece(t, "chair-1", "chair", "office", 1.5, 0.9, 0.65, 0.65),
      piece(t, "bookshelf", "storage", "bookshelf", 0.1, 0, 0.8, 0.32, 180),
      piece(t, "beanbag", "chair", "beanbag", 2.45, 2.0, 0.9, 0.9),
      piece(t, "plant-1", "plant", "palm", 3.0, 0.1, 0.5, 0.5),
    ],
    structures: [
      r.window("window-right", { x: 3.6, y: 1.2, width: 1.1 }),
      r.door("door-back", { x: 0.65, y: 3.2, width: 0.85 }, "left"),
      r.light("light-spot-1", 1.4, 1.2, "spot", 4000),
      r.light("light-spot-2", 2.2, 1.2, "spot", 4000),
    ],
  });
}

function bedroom(t: TFunction): RoomMapConfig {
  const r = rooms(t);
  return makeTemplate({
    dimensions: { widthMeters: 4.0, depthMeters: 3.9, heightMeters: 2.6 },
    // A 50" screen on the wall, over a dresser.
    tvAnchor: { x: 1.45, y: 0.05, width: 1.11, height: 0.06, mountHeightMeters: 1.3, screenKind: "tv", backlightStripId: "usb-tv" },
    usbStrips: [{ stripId: "usb-tv", startX: 1.5, startY: 0.04, endX: 2.51, endY: 0.04, ledCount: 60 }],
    furniture: [
      piece(t, "rug-1", "rug", "rectangle", 0.9, 1.25, 2.2, 1.3),
      piece(t, "dresser", "storage", "dresser", 1.4, 0, 1.2, 0.5, 180),
      piece(t, "wardrobe", "storage", "wardrobe", 2.85, 0, 1.15, 0.6, 180),
      piece(t, "bed-1", "bed", null, 1.2, 1.85, 1.6, 2.05),
      piece(t, "nightstand-left", "storage", "nightstand", 0.7, 3.5, 0.45, 0.4),
      piece(t, "nightstand-right", "storage", "nightstand", 2.85, 3.5, 0.45, 0.4),
      piece(t, "plant-1", "plant", "leafy", 0.1, 0.1, 0.55, 0.55),
    ],
    structures: [
      r.window("window-left", { x: 0, y: 2.0, width: 1.3 }),
      r.door("door-right", { x: 4.0, y: 1.2, width: 0.85 }, "left"),
      r.light("light-ceiling", 2.0, 1.6, "ceiling"),
      r.light("light-bed-left", 0.92, 3.55, "pendant", 2200),
      r.light("light-bed-right", 3.07, 3.55, "pendant", 2200),
    ],
  });
}

function studio(t: TFunction): RoomMapConfig {
  const r = rooms(t);
  return makeTemplate({
    dimensions: { widthMeters: 6.0, depthMeters: 5.0, heightMeters: 2.7 },
    // An L: the living space and the bed along the TV wall, the kitchen down its left leg.
    footprint: [
      { x: 0, y: 0 },
      { x: 6, y: 0 },
      { x: 6, y: 3 },
      { x: 3.6, y: 3 },
      { x: 3.6, y: 5 },
      { x: 0, y: 5 },
    ],
    tvAnchor: { x: 1.69, y: 0.06, width: 1.22, height: 0.08, mountHeightMeters: 1.0, screenKind: "tv", backlightStripId: "usb-tv" },
    usbStrips: [{ stripId: "usb-tv", startX: 1.74, startY: 0.05, endX: 2.86, endY: 0.05, ledCount: 60 }],
    furniture: [
      piece(t, "rug-1", "rug", "rectangle", 1.2, 0.9, 2.2, 1.4),
      piece(t, "tv-unit", "storage", "tvUnit", 1.3, 0, 2.0, 0.42, 180),
      piece(t, "coffee-table", "table", "coffee", 1.8, 1.25, 1.0, 0.5),
      piece(t, "sofa-1", "sofa", "straight", 1.2, 2.0, 2.2, 0.9),
      piece(t, "bed-1", "bed", null, 4.45, 0.9, 1.4, 2.0),
      piece(t, "nightstand", "storage", "nightstand", 3.95, 2.5, 0.45, 0.4),
      piece(t, "dining-table", "table", "dining", 0.4, 3.2, 1.2, 0.8),
      piece(t, "chair-1", "chair", "dining", 0.5, 4.0, 0.45, 0.45),
      piece(t, "chair-2", "chair", "dining", 1.05, 4.0, 0.45, 0.45),
      piece(t, "counter", "kitchen", "counter", 1.7, 4.38, 1.2, 0.62),
      piece(t, "fridge", "kitchen", "fridge", 2.9, 4.32, 0.68, 0.68),
      piece(t, "plant-1", "plant", "palm", 0.15, 0.15, 0.6, 0.6),
    ],
    structures: [
      r.window("window-left", { x: 0, y: 1.4, width: 1.4 }),
      r.window("window-tv", { x: 5.15, y: 0, width: 1.2 }),
      r.door("door-inner", { x: 4.8, y: 3, width: 0.9 }, "right"),
      r.light("light-living", 2.3, 1.5, "ceiling"),
      r.light("light-dining", 1.0, 3.6, "pendant"),
      r.light("light-kitchen-1", 2.0, 4.6, "spot", 3000),
      r.light("light-kitchen-2", 2.9, 4.6, "spot", 3000),
    ],
  });
}

export const ROOM_TEMPLATES: RoomTemplate[] = [
  { id: "tv55", nameKey: "roomMap:templates.tv55.name", descKey: "roomMap:templates.tv55.desc", config: livingRoom, hueSpots: [{ x: 1.45, y: 0.2, heightMeters: 0.75 }, { x: 2.95, y: 0.2, heightMeters: 0.75 }, { x: 0.75, y: 3.5, heightMeters: 1.2 }, { x: 3.55, y: 3.5, heightMeters: 1.2 }, { x: 2.2, y: 1.9, heightMeters: 2.5 }] },
  { id: "ldesk", nameKey: "roomMap:templates.ldesk.name", descKey: "roomMap:templates.ldesk.desc", config: deskSetup, hueSpots: [{ x: 0.85, y: 0.15, heightMeters: 0.95 }, { x: 1.75, y: 0.15, heightMeters: 0.95 }, { x: 2.55, y: 2.8, heightMeters: 1.5 }, { x: 1.6, y: 1.5, heightMeters: 2.4 }] },
  { id: "fullroom", nameKey: "roomMap:templates.fullroom.name", descKey: "roomMap:templates.fullroom.desc", config: fullRoom, hueSpots: [{ x: 1.85, y: 0.25, heightMeters: 0.8 }, { x: 3.65, y: 0.25, heightMeters: 0.8 }, { x: 1.2, y: 4.4, heightMeters: 1.2 }, { x: 4.3, y: 4.4, heightMeters: 1.2 }, { x: 2.75, y: 2.3, heightMeters: 2.6 }] },
  { id: "gaming", nameKey: "roomMap:templates.gaming.name", descKey: "roomMap:templates.gaming.desc", config: gamingCorner, hueSpots: [{ x: 1.2, y: 0.15, heightMeters: 1.0 }, { x: 2.4, y: 0.15, heightMeters: 1.0 }, { x: 0.5, y: 0.2, heightMeters: 1.8 }, { x: 3.3, y: 2.9, heightMeters: 0.4 }] },
  { id: "bedroom", nameKey: "roomMap:templates.bedroom.name", descKey: "roomMap:templates.bedroom.desc", config: bedroom, hueSpots: [{ x: 1.3, y: 0.3, heightMeters: 1.0 }, { x: 2.7, y: 0.3, heightMeters: 1.0 }, { x: 0.92, y: 3.7, heightMeters: 0.7 }, { x: 3.07, y: 3.7, heightMeters: 0.7 }, { x: 2.0, y: 1.6, heightMeters: 2.5 }] },
  { id: "studio", nameKey: "roomMap:templates.studio.name", descKey: "roomMap:templates.studio.desc", config: studio, hueSpots: [{ x: 1.5, y: 0.25, heightMeters: 0.8 }, { x: 3.1, y: 0.25, heightMeters: 0.8 }, { x: 1.0, y: 2.6, heightMeters: 1.2 }, { x: 3.45, y: 2.7, heightMeters: 1.2 }, { x: 1.0, y: 3.6, heightMeters: 1.9 }] },
  { id: "showroom", nameKey: "roomMap:templates.showroom.name", descKey: "roomMap:templates.showroom.desc", config: showroom },
  { id: "empty", nameKey: "roomMap:templates.empty.name", descKey: "roomMap:templates.empty.desc", config: () => DEFAULT_ROOM_MAP },
];
