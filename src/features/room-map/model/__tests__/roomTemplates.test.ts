import type { TFunction } from "i18next";
import { describe, expect, it } from "vitest";

import { type RoomCorner, resolveRoomFootprint } from "@/shared/contracts/roomMap";

import { ROOM_TEMPLATES } from "../roomTemplates";
import { templateFacts } from "../templateFacts";

const EPS = 1e-6;

function inside(p: RoomCorner, outline: RoomCorner[]): boolean {
  let hit = false;
  for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
    const a = outline[i]!;
    const b = outline[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) hit = !hit;
  }
  return hit;
}

// Sampled a little in from each edge, so a box flush with a wall still reads as inside.
function boxInside(x: number, y: number, w: number, h: number, outline: RoomCorner[]): boolean {
  const steps = 6;
  for (let i = 0; i <= steps; i++) {
    for (let j = 0; j <= steps; j++) {
      const p = { x: x + 0.01 + ((w - 0.02) * i) / steps, y: y + 0.01 + ((h - 0.02) * j) / steps };
      if (!inside(p, outline)) return false;
    }
  }
  return true;
}

function onAWall(p: RoomCorner, outline: RoomCorner[]): boolean {
  return outline.some((a, i) => {
    const b = outline[(i + 1) % outline.length]!;
    const alongX = Math.abs(a.y - b.y) < EPS;
    return alongX
      ? Math.abs(p.y - a.y) < EPS && p.x > Math.min(a.x, b.x) && p.x < Math.max(a.x, b.x)
      : Math.abs(p.x - a.x) < EPS && p.y > Math.min(a.y, b.y) && p.y < Math.max(a.y, b.y);
  });
}

describe.each(ROOM_TEMPLATES.filter((template) => template.id !== "empty").map((template) => [template.id, template.config(), template.hueSpots ?? []] as const))(
  "the %s template",
  (_id, config, spots) => {
    const outline = resolveRoomFootprint(config);

    it("suggests Hue spots inside the room and under its ceiling", () => {
      for (const spot of spots) {
        expect(inside(spot, outline), JSON.stringify(spot)).toBe(true);
        expect(spot.heightMeters).toBeGreaterThan(0);
        expect(spot.heightMeters).toBeLessThanOrEqual(config.dimensions.heightMeters);
      }
    });

    // A name stored in the language the template was laid out in stayed in it after a switch.
    it("names nothing, so each piece is called by its model in the app's language", () => {
      expect(config.furniture.filter((f) => f.label !== undefined).map((f) => f.id)).toEqual([]);
      expect((config.structures ?? []).filter((s) => s.label !== undefined).map((s) => s.id)).toEqual([]);
    });

    it("stands every piece, the screen and the strips inside its walls", () => {
      for (const f of config.furniture) expect(boxInside(f.x, f.y, f.width, f.height, outline), f.id).toBe(true);
      if (config.tvAnchor) expect(boxInside(config.tvAnchor.x, config.tvAnchor.y, config.tvAnchor.width, config.tvAnchor.height, outline)).toBe(true);
      for (const s of config.usbStrips) {
        expect(inside({ x: s.startX, y: s.startY }, outline), s.stripId).toBe(true);
        expect(inside({ x: s.endX, y: s.endY }, outline), s.stripId).toBe(true);
      }
    });

    it("keeps its pieces apart, a rug aside", () => {
      const solid = config.furniture.filter((f) => f.type !== "rug");
      for (const [i, a] of solid.entries()) {
        for (const b of solid.slice(i + 1)) {
          const overlap = a.x < b.x + b.width - EPS && b.x < a.x + a.width - EPS && a.y < b.y + b.height - EPS && b.y < a.y + a.height - EPS;
          expect(overlap, `${a.id} × ${b.id}`).toBe(false);
        }
      }
    });

    it("sets its windows and doors in a wall and hangs its lights inside", () => {
      for (const s of config.structures ?? []) {
        if (s.kind === "window" || s.kind === "door") expect(onAWall(s, outline), s.id).toBe(true);
        if (s.kind === "light") expect(inside(s, outline), s.id).toBe(true);
      }
    });

    it("lights its screen with its own strip", () => {
      const bound = config.tvAnchor?.backlightStripId;
      if (bound) expect(config.usbStrips.map((s) => s.stripId)).toContain(bound);
    });
  },
);

it("draws the studio flat as an L", () => {
  const studio = ROOM_TEMPLATES.find((template) => template.id === "studio")!.config();
  expect(resolveRoomFootprint(studio)).toHaveLength(6);
});

describe("templateFacts", () => {
  const tt = ((key: string, values: Record<string, unknown>) => `${key} ${JSON.stringify(values)}`) as unknown as TFunction;

  it("gives the room's floor and its screen's diagonal in inches", () => {
    const living = ROOM_TEMPLATES.find((template) => template.id === "tv55")!.config();
    expect(templateFacts(living, tt, "en")).toBe('roomMap:templates.factsScreen {"w":"4.4","d":"3.8","inch":55}');
  });

  it("reads an ultrawide by its own aspect, and writes a Turkish decimal comma", () => {
    const gaming = ROOM_TEMPLATES.find((template) => template.id === "gaming")!.config();
    expect(templateFacts(gaming, tt, "tr")).toBe('roomMap:templates.factsScreen {"w":"3,6","d":"3,2","inch":34}');
  });

  it("gives only the floor when there is no screen", () => {
    const blank = ROOM_TEMPLATES.find((template) => template.id === "empty")!.config();
    expect(templateFacts(blank, tt, "en")).toMatch(/^roomMap:templates\.facts \{/);
  });
});
