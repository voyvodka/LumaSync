import { describe, it, expect } from "vitest";
import type { HueZone, RoomMapConfig } from "@/shared/contracts/roomMap";
import { DEFAULT_ROOM_MAP } from "@/shared/contracts/roomMap";
import { resolveInspectorTarget } from "../resolveInspectorTarget";

const zone: HueZone = {
  id: "zone-a",
  name: "Behind TV",
  entertainmentAreaId: "area-1",
  centerX: 0,
  centerY: 0,
  centerZ: 0,
  scaleX: 1,
  scaleY: 1,
  scaleZ: 1,
  channelIndices: [4],
};

function configWith(overrides: Partial<RoomMapConfig>): RoomMapConfig {
  return {
    ...DEFAULT_ROOM_MAP,
    imageLayers: [],
    furniture: [],
    usbStrips: [],
    hueChannels: [],
    zones: [],
    tvAnchor: undefined,
    ...overrides,
  };
}

const populated = configWith({
  tvAnchor: { x: 0, y: 0, width: 1.2, height: 0.7 },
  furniture: [{ id: "f1", type: "sofa", x: 0, y: 0, width: 2, height: 1 }],
  usbStrips: [{ stripId: "s1", startX: 0, startY: 0, endX: 1, endY: 0, ledCount: 60 }],
  imageLayers: [{ id: "i1", path: "/tmp/plan.png", label: "Plan", offsetX: 0, offsetY: 0, scale: 1 }],
  hueChannels: [
    { channelIndex: 0, x: 0, y: 0, z: 0 },
    { channelIndex: 4, x: 0, y: 0, z: 0, zoneId: "zone-a" },
  ],
  zones: [zone],
});

describe("resolveInspectorTarget", () => {
  it("returns empty when nothing is selected", () => {
    expect(resolveInspectorTarget(populated, null, null)).toEqual({ kind: "empty" });
  });

  it("resolves each concrete selection to its own inspector kind", () => {
    expect(resolveInspectorTarget(populated, "tv", null).kind).toBe("tv");
    expect(resolveInspectorTarget(populated, "furniture-f1", null).kind).toBe("furniture");
    expect(resolveInspectorTarget(populated, "usb-s1", null).kind).toBe("usb");
    expect(resolveInspectorTarget(populated, "hue-0", null).kind).toBe("hueChannel");
    expect(resolveInspectorTarget(populated, "img-i1", null).kind).toBe("image");
  });

  it("keys a Hue channel on channelIndex rather than array position", () => {
    const target = resolveInspectorTarget(populated, "hue-4", null);
    expect(target).toMatchObject({ kind: "hueChannel", channel: { channelIndex: 4 } });
    // index 1 is the array slot of channel 4 — it must not resolve
    expect(resolveInspectorTarget(populated, "hue-1", null)).toEqual({ kind: "empty" });
  });

  it("resolves the parent zone name for an assigned channel, null for a loose one", () => {
    expect(resolveInspectorTarget(populated, "hue-4", null)).toMatchObject({
      zoneName: "Behind TV",
    });
    expect(resolveInspectorTarget(populated, "hue-0", null)).toMatchObject({ zoneName: null });
  });

  it("yields a null zone name when the channel points at a zone that is gone", () => {
    const orphaned = configWith({
      hueChannels: [{ channelIndex: 0, x: 0, y: 0, z: 0, zoneId: "missing" }],
      zones: [],
    });

    expect(resolveInspectorTarget(orphaned, "hue-0", null)).toMatchObject({
      kind: "hueChannel",
      zoneName: null,
    });
  });

  it("lets a concrete object selection win over an active Hue zone (W4-F2 priority swap)", () => {
    expect(resolveInspectorTarget(populated, "furniture-f1", "zone-a").kind).toBe("furniture");
  });

  it("falls back to the active Hue zone only when no object is selected", () => {
    expect(resolveInspectorTarget(populated, null, "zone-a")).toEqual({ kind: "hueZone", zone });
  });

  it("falls through to the active zone when the selected id no longer exists", () => {
    expect(resolveInspectorTarget(populated, "furniture-gone", "zone-a")).toEqual({
      kind: "hueZone",
      zone,
    });
  });

  it("returns empty for a `tv` selection when no anchor is placed", () => {
    expect(resolveInspectorTarget(configWith({}), "tv", null)).toEqual({ kind: "empty" });
  });

  it("returns empty for an active zone id that matches no zone", () => {
    expect(resolveInspectorTarget(populated, null, "zone-gone")).toEqual({ kind: "empty" });
  });

  it("ignores an unrecognised id prefix entirely", () => {
    expect(resolveInspectorTarget(populated, "zone-a", null)).toEqual({ kind: "empty" });
  });
});
