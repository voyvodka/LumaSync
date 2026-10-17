import { describe, expect, it } from "vitest";

import { DEFAULT_ROOM_MAP, type RoomMapConfig } from "@/shared/contracts/roomMap";

import { landCarried, landCarriedWith } from "../carryLanding";
import { furnitureObjectId } from "../objectId";

const ctx = { hueAreaId: null };
const base: RoomMapConfig = {
  ...DEFAULT_ROOM_MAP,
  dimensions: { widthMeters: 5, depthMeters: 4, heightMeters: 2.5 },
  tvAnchor: { x: 2, y: 0, width: 1.2, height: 0.1 },
  furniture: [{ id: "sofa", type: "sofa", x: 1, y: 2, width: 2, height: 0.9 }],
  usbStrips: [{ stripId: "s1", startX: 1, startY: 1, endX: 3, endY: 1, ledCount: 60 }],
  hueChannels: [{ channelIndex: 0, x: 0, y: 0, z: 0 }],
};

describe("landCarried", () => {
  it("puts the TV down with its middle where it was let go, inside the walls", () => {
    expect(landCarried(base, "tv", 1, 2, 0, ctx)?.tvAnchor).toMatchObject({ x: 0.4, y: 1.95 });
    expect(landCarried(base, "tv", 9, 2, 0, ctx)?.tvAnchor?.x).toBeCloseTo(3.8);
  });

  // Left behind, the backlight stopped being the screen's and was drawn as a wall line.
  it("takes the TV's backlight strip with it, and leaves any other strip", () => {
    const backlight = { stripId: "bl", startX: 2, startY: 0.1, endX: 3.2, endY: 0.1, ledCount: 40 };
    const patch = landCarried({ ...base, usbStrips: [...base.usbStrips, backlight] }, "tv", 1.6, 0.05, 0, ctx);
    expect(patch?.usbStrips?.find((s) => s.stripId === "bl")).toMatchObject({ startX: 1, endX: 2.2 });
    expect(patch?.usbStrips?.find((s) => s.stripId === "s1")).toEqual(base.usbStrips[0]);
  });

  it("puts a house light down at the plan point, and raises it by the rise from where it was drawn", () => {
    const lit = { ...base, structures: [{ id: "lamp", kind: "light" as const, x: 1, y: 1, fixture: "ceiling" as const }] };
    expect(landCarried(lit, "decor-lamp", 2, 3, 0, ctx)?.structures?.[0]).toMatchObject({ x: 2, y: 3 });
    // A ceiling light hangs at 2.5 m; let go 0.5 m lower, it is stored 0.5 m below the ceiling.
    expect(landCarried(lit, "decor-lamp", 2, 3, 0, ctx, { rise: -0.5, centreY: 1.9 })?.structures?.[0]).toMatchObject({ x: 2, y: 3, dropMeters: 0.5 });
    expect(landCarried({ ...lit, structures: [{ ...lit.structures[0]!, locked: true }] }, "decor-lamp", 2, 3, 0, ctx)).toBeNull();
  });

  it("puts a Hue light down at the plan point in the bridge's cube", () => {
    const ch = landCarried(base, "hue-0", 0, 0, 0, ctx)?.hueChannels?.[0];
    // The room's top-left corner is the cube's left wall and TV wall.
    expect(ch).toMatchObject({ x: -1, y: 1 });
  });

  it("raises the TV's centre to where ⇧ let it go, inside the room's height", () => {
    expect(landCarried(base, "tv", 1, 2, 0, ctx, { rise: 0.3, centreY: 1.312 })?.tvAnchor).toMatchObject({ x: 0.4, mountHeightMeters: 1.31 });
    expect(landCarried(base, "tv", 1, 2, 0, ctx, { rise: 3, centreY: 4 })?.tvAnchor?.mountHeightMeters).toBe(2.5);
    expect(landCarried(base, "tv", 1, 2, 0, ctx)?.tvAnchor?.mountHeightMeters).toBeUndefined();
  });

  it("raises a Hue light from the height it was drawn at, the TV's while its own is unknown", () => {
    const unknown = landCarried(base, "hue-0", 0, 0, 0, ctx, { rise: 0.5, centreY: 0 })?.hueChannels?.[0];
    // Drawn at the default mount, 40% of 2.5 m: 1.5 m is z 0.2.
    expect(unknown?.z).toBeCloseTo(0.2);
    expect(unknown?.zOrigin).toBe("user");
    const known = { ...base, hueChannels: [{ channelIndex: 0, x: 0, y: 0, z: 0, zOrigin: "bridge" as const }] };
    expect(landCarried(known, "hue-0", 0, 0, 0, ctx, { rise: -0.5, centreY: 0 })?.hueChannels?.[0]?.z).toBeCloseTo(-0.4);
    expect(landCarried(known, "hue-0", 0, 0, 0, ctx, { rise: 9, centreY: 0 })?.hueChannels?.[0]?.z).toBe(1);
  });

  it("raises the viewed area's light alone, not another area's of the same number", () => {
    const two = {
      ...base,
      hueChannels: [
        { channelIndex: 0, x: 0, y: 0, z: 0, zOrigin: "bridge" as const, entertainmentAreaId: "b" },
        { channelIndex: 0, x: 0, y: 0, z: 0, zOrigin: "bridge" as const, entertainmentAreaId: "a" },
      ],
    };
    const lifted = landCarried(two, "hue-0", 0, 0, 0, { hueAreaId: "a" }, { rise: 0.5, centreY: 0 })?.hueChannels;
    expect(lifted?.[0]).toEqual(two.hueChannels[0]);
    expect(lifted?.[1]?.z).toBeCloseTo(0.4);
  });

  it("keeps a zone-bound light's rise inside its zone", () => {
    const zone = { id: "z1", name: "Z", entertainmentAreaId: "a", centerX: 0, centerY: 0, centerZ: 0, scaleX: 1, scaleY: 1, scaleZ: 0.2, channelIndices: [0] };
    const bound: RoomMapConfig = {
      ...base,
      zones: [zone],
      hueChannels: [{ channelIndex: 0, x: 0, y: 0, z: 0, zOrigin: "user", entertainmentAreaId: "a", zoneId: "z1", zoneRelativePosition: { x: 0, y: 0, z: 0 } }],
    };
    const ch = landCarried(bound, "hue-0", 2.5, 2, 0, ctx, { rise: 1, centreY: 0 })?.hueChannels?.[0];
    expect(ch?.zoneRelativePosition?.z).toBe(1);
  });

  it("slides a strip whole so its middle lands there", () => {
    const strip = landCarried(base, "usb-s1", 2.5, 3, 0, ctx)?.usbStrips?.[0];
    expect(strip).toMatchObject({ startX: 1.5, endX: 3.5, startY: 3, endY: 3 });
  });

  it("turns only furniture, and moves nothing locked", () => {
    expect(landCarried(base, "furniture-sofa", 2.5, 2, 15, ctx)?.furniture?.[0]?.rotation).toBe(15);
    expect(landCarried({ ...base, tvAnchor: { ...base.tvAnchor!, locked: true } }, "tv", 1, 1, 0, ctx)).toBeNull();
  });
});

describe("landCarriedWith", () => {
  const desk = { id: "desk", type: "table" as const, variant: "desk" as const, x: 1, y: 0, width: 1.6, height: 0.7 };
  const config: RoomMapConfig = { ...base, furniture: [desk], tvAnchor: { x: 1.3, y: 0.2, width: 0.6, height: 0.05 } };

  // Left behind, the monitor hung in the air while the desk was carried and stood on nothing after.
  it("moves what rode on the piece by as far as the piece landed from where it stood", () => {
    const patch = landCarriedWith(config, furnitureObjectId("desk"), 2.8, 2.35, 0, ["tv"], ctx);
    expect(patch?.furniture?.[0]).toMatchObject({ x: 2, y: 2 });
    expect(patch?.tvAnchor?.x).toBeCloseTo(2.3);
    expect(patch?.tvAnchor?.y).toBeCloseTo(2.2);
  });

  it("lands the piece alone when its rider is locked, and as landCarried with no riders", () => {
    const locked = { ...config, tvAnchor: { ...config.tvAnchor!, locked: true } };
    expect(landCarriedWith(locked, furnitureObjectId("desk"), 2.8, 2.35, 0, ["tv"], ctx)?.tvAnchor).toBeUndefined();
    expect(landCarriedWith(config, furnitureObjectId("desk"), 2.8, 2.35, 0, [], ctx)).toEqual(landCarried(config, furnitureObjectId("desk"), 2.8, 2.35, 0, ctx));
  });
});
