import { describe, expect, it } from "vitest";

import {
  resolveHueFacing,
  resolveHueFixture,
  findHueChannel,
  resolveRoomSurfaces,
  type RoomSurfaces,
  type FurniturePlacement,
  hueChannelsForArea,
  mergeHueChannels,
  replaceHueChannel,
  resolveFurnitureTone,
  resolveFurnitureTop,
  resolveStripMountHeight,
  type UsbStripPlacement,
  resolveFurnitureType,
  resolveFurnitureVariant,
  resolveRoomFootprint,
  type RoomMapConfig,
  resolveScreenKind,
  type HueChannelPlacement,
} from "@/shared/contracts/roomMap";

function channel(channelIndex: number): HueChannelPlacement {
  return { channelIndex, x: 0, y: 0, z: 0 };
}


describe("findHueChannel", () => {
  it("matches on channelIndex, not on array position", () => {
    const channels = [channel(0), channel(2)];

    expect(findHueChannel(channels, 2)).toBe(channels[1]);
    expect(findHueChannel(channels, 1)).toBeUndefined();
  });
});

describe("mergeHueChannels", () => {
  it("keeps placements the editor never saw", () => {
    // The Hue panel only ever emits the channels one bridge is reporting, so
    // assigning its output straight onto the config deleted the rest.
    const stored = [channel(0), channel(1), channel(2)];
    const edited = [{ ...channel(1), x: 0.7 }];

    const merged = mergeHueChannels(stored, edited);

    expect(merged.map((c) => c.channelIndex).sort()).toEqual([0, 1, 2]);
    expect(findHueChannel(merged, 1)!.x).toBe(0.7);
  });

  it("replaces rather than duplicates an edited channel", () => {
    const merged = mergeHueChannels([channel(0)], [{ ...channel(0), x: -0.4 }]);

    expect(merged).toHaveLength(1);
    expect(merged[0].x).toBe(-0.4);
  });

  it("keeps everything when the bridge reports nothing", () => {
    const stored = [channel(0), channel(3)];
    expect(mergeHueChannels(stored, [])).toEqual(stored);
  });

  it("accepts a channel the stored list does not have yet", () => {
    const merged = mergeHueChannels([channel(0)], [channel(5)]);
    expect(merged.map((c) => c.channelIndex)).toEqual([0, 5]);
  });
});

describe("entertainment-area scoping", () => {
  function inArea(channelIndex: number, entertainmentAreaId: string): HueChannelPlacement {
    return { ...channel(channelIndex), entertainmentAreaId };
  }

  it("keeps two areas' identically-numbered channels apart", () => {
    // The whole point of the field: before it, both were `channelIndex: 0` and
    // the second area's placement replaced the first's.
    const stored = [inArea(0, "ea-a")];
    const merged = mergeHueChannels(stored, [{ ...inArea(0, "ea-b"), x: 0.9 }]);

    expect(merged).toHaveLength(2);
    expect(merged.find((c) => c.entertainmentAreaId === "ea-a")!.x).toBe(0);
    expect(merged.find((c) => c.entertainmentAreaId === "ea-b")!.x).toBe(0.9);
  });

  it("still replaces rather than duplicates within one area", () => {
    const merged = mergeHueChannels([inArea(0, "ea-a")], [{ ...inArea(0, "ea-a"), x: -0.5 }]);

    expect(merged).toHaveLength(1);
    expect(merged[0].x).toBe(-0.5);
  });

  it("absorbs an unscoped record instead of leaving a pre-adoption copy", () => {
    // `hueChannelsForArea` lends unscoped records to the viewed area, so they
    // come back stamped; a strict area match would keep both.
    const merged = mergeHueChannels([channel(0)], [{ ...inArea(0, "ea-a"), x: 0.3 }]);

    expect(merged).toHaveLength(1);
    expect(merged[0].entertainmentAreaId).toBe("ea-a");
  });

  it("shows one area's channels plus the unscoped ones", () => {
    const stored = [inArea(0, "ea-a"), inArea(1, "ea-b"), channel(2)];

    expect(hueChannelsForArea(stored, "ea-a").map((c) => c.channelIndex)).toEqual([0, 2]);
    expect(hueChannelsForArea(stored, "ea-b").map((c) => c.channelIndex)).toEqual([1, 2]);
  });

  it("replaces in place without touching the same index in another area", () => {
    const stored = [inArea(0, "ea-a"), inArea(0, "ea-b"), inArea(1, "ea-a")];
    const next = replaceHueChannel(stored, { ...inArea(0, "ea-b"), x: 0.7 });

    expect(next.map((c) => c.entertainmentAreaId)).toEqual(["ea-a", "ea-b", "ea-a"]);
    expect(next[0].x).toBe(0);
    expect(next[1].x).toBe(0.7);
  });
});

describe("furniture resolvers", () => {
  const piece = (patch: Partial<FurniturePlacement> & { type: string }): FurniturePlacement =>
    ({ id: "p", x: 0, y: 0, width: 1, height: 1, ...patch }) as FurniturePlacement;

  it("reads a type from a newer build as other, so no reader meets an unknown one", () => {
    expect(resolveFurnitureType("bed")).toBe("bed");
    expect(resolveFurnitureType("hammock")).toBe("other");
    expect(resolveFurnitureType(undefined)).toBe("other");
  });

  it("keeps a variant and a tone only where the type takes them", () => {
    expect(resolveFurnitureVariant(piece({ type: "table", variant: "desk" }))).toBe("desk");
    expect(resolveFurnitureVariant(piece({ type: "table", variant: "bookshelf" }))).toBeUndefined();
    expect(resolveFurnitureTone(piece({ type: "sofa", tone: "slate" }))).toBe("slate");
    expect(resolveFurnitureTone(piece({ type: "sofa", tone: "walnut" }))).toBeUndefined();
  });
});

describe("height and screen kind resolvers", () => {
  const piece = (topMeters: unknown): FurniturePlacement =>
    ({ id: "p", type: "storage", x: 0, y: 0, width: 1, height: 0.4, topMeters }) as FurniturePlacement;

  it("keeps only a usable stored height", () => {
    expect(resolveFurnitureTop(piece(1.8))).toBe(1.8);
    for (const bad of [null, 0, -1, Number.NaN, 12, "2"]) expect(resolveFurnitureTop(piece(bad))).toBeUndefined();
  });

  it("keeps only a strip height at or above the floor", () => {
    const strip = (mountHeightMeters: unknown) =>
      ({ stripId: "s", startX: 0, startY: 0, endX: 1, endY: 0, ledCount: 30, mountHeightMeters }) as UsbStripPlacement;
    expect(resolveStripMountHeight(strip(0))).toBe(0);
    expect(resolveStripMountHeight(strip(2.4))).toBe(2.4);
    expect(resolveStripMountHeight(strip(4.5))).toBe(4.5);
    for (const bad of [undefined, null, -0.1, Number.NaN, Number.POSITIVE_INFINITY, "1"]) expect(resolveStripMountHeight(strip(bad))).toBeUndefined();
  });

  it("reads an unknown screen kind as Auto", () => {
    expect(resolveScreenKind("monitor")).toBe("monitor");
    expect(resolveScreenKind("projector")).toBeUndefined();
    expect(resolveScreenKind(undefined)).toBeUndefined();
  });
});

describe("resolveRoomFootprint", () => {
  const dims = { widthMeters: 5, depthMeters: 4, heightMeters: 2.5 };
  const RECT = [
    { x: 0, y: 0 },
    { x: 5, y: 0 },
    { x: 5, y: 4 },
    { x: 0, y: 4 },
  ];
  // An L: the bottom-right 2 × 1.5 m corner cut away, as the plan reads it (room on the right).
  const L = [
    { x: 0, y: 0 },
    { x: 5, y: 0 },
    { x: 5, y: 2.5 },
    { x: 3, y: 2.5 },
    { x: 3, y: 4 },
    { x: 0, y: 4 },
  ];
  const read = (footprint: unknown, dimensions = dims) =>
    resolveRoomFootprint({ dimensions, footprint: footprint as RoomMapConfig["footprint"] });

  it.each([
    ["absent", undefined],
    ["null", null],
    ["a string", "L"],
    ["a non-finite corner", [...L.slice(0, 5), { x: Number.NaN, y: 4 }]],
    ["a corner that is not a point", [...L.slice(0, 5), "0,4"]],
    ["three corners", L.slice(0, 3)],
    ["five corners", L.slice(0, 5)],
    ["seven corners", [...L, { x: 0, y: 2 }]],
    ["ten corners", [...L, ...L.slice(0, 4)]],
    ["a diagonal wall", [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 2.5 }, { x: 3, y: 4 }, { x: 1, y: 4 }, { x: 0, y: 4 }]],
    ["a zero-length wall", [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 4 }, { x: 0, y: 4 }, { x: 0, y: 4 }]],
    ["two walls in one line", [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 4 }, { x: 2, y: 4 }, { x: 0, y: 4 }]],
    ["a closing duplicate", [...RECT, RECT[0], RECT[1]]],
    ["a wall shorter than 10 cm", [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 3.95 }, { x: 3, y: 3.95 }, { x: 3, y: 4 }, { x: 0, y: 4 }]],
    ["an outline smaller than the room", [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 2.5 }, { x: 3, y: 2.5 }, { x: 3, y: 4 }, { x: 0, y: 4 }]],
    ["an outline larger than the room", [{ x: 0, y: 0 }, { x: 6, y: 0 }, { x: 6, y: 2.5 }, { x: 3, y: 2.5 }, { x: 3, y: 4 }, { x: 0, y: 4 }]],
    ["an outline offset from the room", L.map((c) => ({ x: c.x + 0.5, y: c.y }))],
  ])("reads %s as the rectangle", (_name, footprint) => {
    expect(read(footprint)).toEqual(RECT);
  });

  it("reads walls that touch away from their own corners as the rectangle", () => {
    // A notch cut up from the far wall all the way to the TV wall: its side touches that wall.
    const touching = [
      { x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 4 }, { x: 3, y: 4 },
      { x: 3, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 4 }, { x: 0, y: 4 },
    ];
    expect(read(touching)).toEqual(RECT);
    // Inside the room's box, but one wall runs across another.
    const crossing = [{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 4 }, { x: 5, y: 4 }, { x: 5, y: 1 }, { x: 0, y: 1 }];
    expect(read(crossing)).toEqual(RECT);
  });

  it("keeps a usable L, and the plain rectangle as itself", () => {
    expect(read(L)).toEqual(L);
    expect(read(RECT)).toEqual(RECT);
  });

  it("snaps a corner up to a millimetre off its wall or the room's edge onto it", () => {
    const off = L.map((c, i) => (i === 3 ? { x: 3.0004, y: 2.5004 } : i === 1 ? { x: 5.0005, y: 0 } : c));
    expect(read(off)).toEqual(L);
  });

  it("snaps a whole wall up to a millimetre past the room's edge back onto it", () => {
    const past = L.map((c) => ({ x: c.x === 5 ? 5.0009 : c.x === 0 ? -0.0009 : c.x, y: c.y }));
    expect(read(past)).toEqual(L);
    const odd = { widthMeters: 4.0004, depthMeters: 4, heightMeters: 2.5 };
    const oddL = L.map((c) => ({ x: c.x === 5 ? 4.0004 : c.x, y: c.y }));
    expect(read(oddL, odd)).toEqual(oddL);
  });

  it("reads its own answer as the same answer", () => {
    // A wall just under 10 cm once its corners are snapped must not pass the first reading only.
    const p = 1.0055;
    const near = [
      { x: 0, y: 0 },
      { x: 5, y: 0 },
      { x: 5, y: 4 },
      { x: p + 0.001, y: 4 },
      { x: p, y: 3.9 },
      { x: p + 0.1, y: 3.9 },
      { x: p + 0.1, y: 2.5 },
      { x: 0, y: 2.5 },
    ];
    const shapes: unknown[] = [L, near, L.map((c, i) => (i === 3 ? { x: 3.0004, y: 2.5004 } : c))];
    for (const shape of shapes) {
      const once = read(shape);
      expect(read(once)).toEqual(once);
    }
    // Notches near every limit — wall lengths around 10 cm, corners up to a millimetre off — from a
    // fixed seed, so a failure reproduces.
    let seed = 7;
    const next = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (let k = 0; k < 2000; k++) {
      const p0 = 0.2 + next() * 3;
      const wall = 0.098 + next() * 0.006;
      const jitter = () => (next() - 0.5) * 0.002;
      const shape = [
        { x: 0, y: 0 },
        { x: 5, y: 0 },
        { x: 5 + jitter(), y: 4 },
        { x: p0 + wall + jitter(), y: 4 },
        { x: p0 + wall, y: 3.9 + jitter() },
        { x: p0, y: 3.9 },
        { x: p0 + jitter(), y: 2.5 },
        { x: 0, y: 2.5 + jitter() },
      ];
      const once = read(shape);
      expect(read(once)).toEqual(once);
    }
  });

  it("reads one L in any rotation and either winding as one list", () => {
    const rotations = [0, 1, 2, 3, 4, 5].map((k) => [...L.slice(k), ...L.slice(0, k)]);
    for (const order of [...rotations, ...rotations.map((r) => [...r].reverse())]) {
      expect(read(order)).toEqual(L);
    }
  });

  it("reads an L turned to every side of the room", () => {
    const square = { widthMeters: 4, depthMeters: 4, heightMeters: 2.5 };
    const base = [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 2 }, { x: 2, y: 2 }, { x: 2, y: 4 }, { x: 0, y: 4 }];
    const turn = (c: { x: number; y: number }) => ({ x: 4 - c.y, y: c.x });
    let shape = base;
    for (let quarter = 0; quarter < 4; quarter++) {
      const out = read(shape, square);
      expect(out).toHaveLength(6);
      expect(out[0]).toEqual([...out].sort((a, b) => a.y - b.y || a.x - b.x)[0]);
      shape = shape.map(turn);
    }
  });

  it("keeps a U and a T", () => {
    const U = [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 4 }, { x: 3.5, y: 4 }, { x: 3.5, y: 2 }, { x: 1.5, y: 2 }, { x: 1.5, y: 4 }, { x: 0, y: 4 }];
    const T = [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 1.5 }, { x: 3.5, y: 1.5 }, { x: 3.5, y: 4 }, { x: 1.5, y: 4 }, { x: 1.5, y: 1.5 }, { x: 0, y: 1.5 }];
    expect(read(U)).toEqual(U);
    expect(read(T)).toEqual(T);
  });

  it("ignores extra keys on a corner", () => {
    expect(read(L.map((c) => ({ ...c, label: "x" })))).toEqual(L);
  });
});

describe("resolveRoomSurfaces", () => {
  it("reads a room with none as oak and warm white", () => {
    expect(resolveRoomSurfaces({})).toEqual({ floor: "oak", walls: "warmWhite" });
  });

  it("reads what it does not know as the default, without touching what is stored", () => {
    const surfaces = { floor: "marble", walls: "sage" } as unknown as RoomSurfaces;
    expect(resolveRoomSurfaces({ surfaces })).toEqual({ floor: "oak", walls: "sage" });
    expect(surfaces).toEqual({ floor: "marble", walls: "sage" });
  });

  it("reads an unknown wall colour, or a value that is not an object, as the defaults", () => {
    expect(resolveRoomSurfaces({ surfaces: { walls: "neon" } as unknown as RoomSurfaces }).walls).toBe("warmWhite");
    expect(resolveRoomSurfaces({ surfaces: "x" as unknown as RoomSurfaces })).toEqual({ floor: "oak", walls: "warmWhite" });
  });
});

describe("Hue channel facing and fixture", () => {
  const ch = { channelIndex: 0, x: 0, y: 0, z: 0 };
  it("reads a stored facing into [0, 360) and anything else as unset", () => {
    expect(resolveHueFacing({ ...ch, facing: -90 })).toBe(270);
    expect(resolveHueFacing({ ...ch, facing: 450 })).toBe(90);
    expect(resolveHueFacing({ ...ch, facing: null })).toBeUndefined();
    expect(resolveHueFacing({ ...ch, facing: Number.NaN })).toBeUndefined();
  });

  // A newer build's fixture must read as "from the bridge" here, not throw a lookup.
  it("reads a known fixture and treats an unknown one as from the bridge", () => {
    expect(resolveHueFixture({ ...ch, fixture: "iris" })).toBe("iris");
    expect(resolveHueFixture({ ...ch, fixture: "lantern2030" as never })).toBeUndefined();
  });
});
