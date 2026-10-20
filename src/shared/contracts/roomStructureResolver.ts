// The room structures' readers, apart from the types in `roomMap.ts`: that module is in the entry
// chunk, and only the lazy room map and 3D view read structures.

import { clampKelvin } from "./mode";
import {
  DECOR_LIGHT_FIXTURES,
  type DecorLightFixture,
  type RoomMapConfig,
  type RoomStructure,
  STRUCTURE_KINDS,
  type StructureBase,
  type WallStructure,
} from "./roomMap";

export function isWallStructure(structure: RoomStructure): structure is WallStructure {
  return structure.kind === STRUCTURE_KINDS.WINDOW || structure.kind === STRUCTURE_KINDS.DOOR || structure.kind === STRUCTURE_KINDS.NICHE;
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const positive = (value: unknown): value is number => finite(value) && value > 0;
const atLeastZero = (value: unknown): value is number => finite(value) && value >= 0;

function structureBase(entry: Record<string, unknown>): StructureBase | null {
  if (typeof entry.id !== "string" || entry.id === "") return null;
  return {
    id: entry.id,
    ...(typeof entry.label === "string" ? { label: entry.label } : {}),
    ...(entry.locked === true ? { locked: true } : {}),
  };
}

function resolveStructure(entry: Record<string, unknown>): RoomStructure | null {
  const base = structureBase(entry);
  if (!base) return null;
  const e = entry;
  switch (e.kind) {
    case STRUCTURE_KINDS.COLUMN:
      if (!finite(e.x) || !finite(e.y) || !positive(e.width) || !positive(e.depth)) return null;
      return {
        ...base,
        kind: STRUCTURE_KINDS.COLUMN,
        x: e.x,
        y: e.y,
        width: e.width,
        depth: e.depth,
        ...(finite(e.rotation) ? { rotation: e.rotation } : {}),
        ...(e.shape === "round" || e.shape === "square" ? { shape: e.shape } : {}),
      };
    case STRUCTURE_KINDS.BEAM:
      if (![e.x1, e.y1, e.x2, e.y2].every(finite) || !positive(e.width) || !positive(e.dropMeters)) return null;
      return { ...base, kind: STRUCTURE_KINDS.BEAM, x1: e.x1 as number, y1: e.y1 as number, x2: e.x2 as number, y2: e.y2 as number, width: e.width, dropMeters: e.dropMeters };
    case STRUCTURE_KINDS.WINDOW:
      if (!finite(e.x) || !finite(e.y) || !positive(e.width) || !atLeastZero(e.sillMeters) || !positive(e.heightMeters)) return null;
      return { ...base, kind: STRUCTURE_KINDS.WINDOW, x: e.x, y: e.y, width: e.width, sillMeters: e.sillMeters, heightMeters: e.heightMeters };
    case STRUCTURE_KINDS.DOOR:
      if (!finite(e.x) || !finite(e.y) || !positive(e.width) || !positive(e.heightMeters)) return null;
      return {
        ...base,
        kind: STRUCTURE_KINDS.DOOR,
        x: e.x,
        y: e.y,
        width: e.width,
        heightMeters: e.heightMeters,
        hinge: e.hinge === "right" ? "right" : "left",
        swing: e.swing === "out" ? "out" : "in",
      };
    case STRUCTURE_KINDS.NICHE:
      if (!finite(e.x) || !finite(e.y) || !positive(e.width) || !atLeastZero(e.bottomMeters) || !positive(e.heightMeters) || !positive(e.depth)) return null;
      return { ...base, kind: STRUCTURE_KINDS.NICHE, x: e.x, y: e.y, width: e.width, bottomMeters: e.bottomMeters, heightMeters: e.heightMeters, depth: e.depth };
    case STRUCTURE_KINDS.LIGHT:
      if (!finite(e.x) || !finite(e.y) || !Object.values(DECOR_LIGHT_FIXTURES).includes(e.fixture as DecorLightFixture)) return null;
      return {
        ...base,
        kind: STRUCTURE_KINDS.LIGHT,
        x: e.x,
        y: e.y,
        fixture: e.fixture as DecorLightFixture,
        ...(atLeastZero(e.dropMeters) && { dropMeters: e.dropMeters }),
        ...(finite(e.kelvin) && { kelvin: clampKelvin(e.kelvin) }),
      };
    default:
      return null;
  }
}

/** The structures this build can draw, in stored order, the first of any repeated id. Read-only:
 *  an unknown kind or a malformed entry is skipped here and left on disk. */
export function resolveRoomStructures(config: Pick<RoomMapConfig, "structures">): RoomStructure[] {
  const stored: unknown = config.structures;
  if (!Array.isArray(stored)) return [];
  const out: RoomStructure[] = [];
  const seen = new Set<string>();
  for (const entry of stored) {
    if (typeof entry !== "object" || entry === null) continue;
    const structure = resolveStructure(entry as Record<string, unknown>);
    if (!structure || seen.has(structure.id)) continue;
    seen.add(structure.id);
    out.push(structure);
  }
  return out;
}
