import { describe, it, expect } from "vitest";
import type { TFunction } from "i18next";
import type { RoomMapConfig } from "@/shared/contracts/roomMap";
import { DEFAULT_ROOM_MAP } from "@/shared/contracts/roomMap";
import { buildObjectList } from "../objectList";

/** Echoes the key plus any interpolation, so label *sourcing* stays visible in assertions. */
const t = ((key: string, opts?: Record<string, string>) =>
  opts ? `${key}(${Object.values(opts).join(",")})` : key) as unknown as TFunction;

function configWith(overrides: Partial<RoomMapConfig>): RoomMapConfig {
  return {
    ...DEFAULT_ROOM_MAP,
    imageLayers: [],
    furniture: [],
    usbStrips: [],
    hueChannels: [],
    tvAnchor: undefined,
    ...overrides,
  };
}

describe("buildObjectList", () => {
  it("returns nothing for an empty map", () => {
    expect(buildObjectList(configWith({}), t)).toEqual([]);
  });

  it("orders rows images → tv → furniture → usb → hue", () => {
    const rows = buildObjectList(
      configWith({
        imageLayers: [{ id: "i1", path: "/tmp/plan.png", label: "Plan", offsetX: 0, offsetY: 0, scale: 1 }],
        tvAnchor: { x: 0, y: 0, width: 1, height: 1 },
        furniture: [{ id: "f1", type: "sofa", x: 0, y: 0, width: 1, height: 1 }],
        usbStrips: [{ stripId: "s1", startX: 0, startY: 0, endX: 1, endY: 0, ledCount: 60 }],
        hueChannels: [{ channelIndex: 0, x: 0, y: 0, z: 0 }],
      }),
      t,
    );

    expect(rows.map((r) => r.type)).toEqual(["image", "tv", "furniture", "usb", "hue"]);
  });

  it("prefixes each id by kind, and leaves the TV anchor unprefixed", () => {
    const rows = buildObjectList(
      configWith({
        imageLayers: [{ id: "i1", path: "/tmp/plan.png", label: "Plan", offsetX: 0, offsetY: 0, scale: 1 }],
        tvAnchor: { x: 0, y: 0, width: 1, height: 1 },
        furniture: [{ id: "f1", type: "sofa", x: 0, y: 0, width: 1, height: 1 }],
        usbStrips: [{ stripId: "s1", startX: 0, startY: 0, endX: 1, endY: 0, ledCount: 60 }],
        hueChannels: [{ channelIndex: 3, x: 0, y: 0, z: 0 }],
      }),
      t,
    );

    expect(rows.map((r) => r.id)).toEqual(["img-i1", "tv", "furniture-f1", "usb-s1", "hue-3"]);
  });

  it("keys a Hue row on channelIndex, not on array position", () => {
    const rows = buildObjectList(
      configWith({ hueChannels: [{ channelIndex: 5, x: 0, y: 0, z: 0 }] }),
      t,
    );

    expect(rows[0].id).toBe("hue-5");
  });

  it("prefers an author-supplied label over the translated fallback", () => {
    const rows = buildObjectList(
      configWith({
        furniture: [{ id: "f1", type: "chair", x: 0, y: 0, width: 1, height: 1, label: "Reading chair" }],
        hueChannels: [{ channelIndex: 0, x: 0, y: 0, z: 0, label: "Left wall" }],
      }),
      t,
    );

    expect(rows.map((r) => r.label)).toEqual(["Reading chair", "Left wall"]);
  });

  it("falls back to the furniture-type key and a 1-based Hue channel number", () => {
    const rows = buildObjectList(
      configWith({
        furniture: [{ id: "f1", type: "table", x: 0, y: 0, width: 1, height: 1 }],
        hueChannels: [{ channelIndex: 0, x: 0, y: 0, z: 0 }],
      }),
      t,
    );

    expect(rows[0].label).toBe("roomMap:furniture.type.table");
    expect(rows[1].label).toBe("roomMap:objectPanel.hueLabel(1)");
  });

  it("carries lock state and the Hue zone assignment through onto the row", () => {
    const rows = buildObjectList(
      configWith({
        furniture: [{ id: "f1", type: "sofa", x: 0, y: 0, width: 1, height: 1, locked: true }],
        hueChannels: [{ channelIndex: 0, x: 0, y: 0, z: 0, zoneId: "zone-a" }],
      }),
      t,
    );

    expect(rows[0].locked).toBe(true);
    expect(rows[1].zoneId).toBe("zone-a");
  });

  it("omits the TV row entirely when no anchor is placed", () => {
    const rows = buildObjectList(configWith({ tvAnchor: undefined }), t);
    expect(rows.some((r) => r.type === "tv")).toBe(false);
  });
});
