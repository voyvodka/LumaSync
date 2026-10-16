import { describe, expect, it } from "vitest";

import { resolveRoomStructures } from "../roomStructureResolver";

describe("resolveRoomStructures", () => {
  it("reads each kind, fills a door's hinge and swing, and keeps a column's shape and turn", () => {
    const structures = resolveRoomStructures({
      structures: [
        { id: "c", kind: "column", x: 1, y: 1, width: 0.4, depth: 0.4, shape: "round", rotation: 15 },
        { id: "b", kind: "beam", x1: 0, y1: 2, x2: 5, y2: 2, width: 0.25, dropMeters: 0.3 },
        { id: "w", kind: "window", x: 2, y: 0, width: 1.2, sillMeters: 0.9, heightMeters: 1.2 },
        { id: "d", kind: "door", x: 0, y: 3, width: 0.9, heightMeters: 2.05 } as never,
        { id: "n", kind: "niche", x: 5, y: 2, width: 0.8, bottomMeters: 0.4, heightMeters: 1, depth: 0.25 },
      ],
    });
    expect(structures.map((s) => s.kind)).toEqual(["column", "beam", "window", "door", "niche"]);
    expect(structures[0]).toMatchObject({ shape: "round", rotation: 15 });
    expect(structures[3]).toMatchObject({ hinge: "left", swing: "in" });
  });

  // A newer build's skylight, or an entry cut short, must neither break the room nor be lost from disk.
  it("skips a kind it does not know and a malformed entry, and leaves the stored array as it was", () => {
    const stored = [
      { id: "s", kind: "skylight", x: 2, y: 2 },
      { id: "w", kind: "window", x: 2, y: 0, width: -1, sillMeters: 0.9, heightMeters: 1.2 },
      { kind: "column", x: 1, y: 1, width: 0.4, depth: 0.4 },
      null,
      { id: "c", kind: "column", x: 1, y: 1, width: 0.4, depth: 0.4, shape: "hexagon" },
    ];
    const before = JSON.stringify(stored);
    const structures = resolveRoomStructures({ structures: stored as never });
    expect(structures).toEqual([{ id: "c", kind: "column", x: 1, y: 1, width: 0.4, depth: 0.4 }]);
    expect(JSON.stringify(stored)).toBe(before);
    expect(resolveRoomStructures({})).toEqual([]);
    expect(resolveRoomStructures({ structures: "x" as never })).toEqual([]);
  });

  it("reads a ceiling light of each fixture, clamps its white and skips a fixture it does not know", () => {
    const structures = resolveRoomStructures({
      structures: [
        { id: "p", kind: "light", x: 1, y: 1, fixture: "pendant", dropMeters: 0.6 },
        { id: "c", kind: "light", x: 2, y: 1, fixture: "ceiling", kelvin: 900 },
        { id: "s", kind: "light", x: 3, y: 1, fixture: "spot", kelvin: 9000 },
        { id: "b", kind: "light", x: 4, y: 1, fixture: "bulb", kelvin: 2201.6 },
        { id: "x", kind: "light", x: 5, y: 1, fixture: "lightstrip" } as never,
      ],
    });
    expect(structures.map((s) => s.id)).toEqual(["p", "c", "s", "b"]);
    expect(structures[0]).toEqual({ id: "p", kind: "light", x: 1, y: 1, fixture: "pendant", dropMeters: 0.6 });
    expect(structures.slice(1).map((s) => (s.kind === "light" ? s.kelvin : null))).toEqual([2000, 6500, 2202]);
  });

  it("keeps the first of two structures with one id", () => {
    const structures = resolveRoomStructures({
      structures: [
        { id: "c", kind: "column", x: 1, y: 1, width: 0.4, depth: 0.4 },
        { id: "c", kind: "column", x: 3, y: 3, width: 0.4, depth: 0.4 },
      ],
    });
    expect(structures).toEqual([{ id: "c", kind: "column", x: 1, y: 1, width: 0.4, depth: 0.4 }]);
  });
});
