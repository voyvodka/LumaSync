import { describe, expect, it } from "vitest";

import { DEFAULT_ROOM_MAP, type RoomMapConfig } from "@/shared/contracts/roomMap";
import type { Equals } from "@/test/typeEquals";

import {
  furnitureObjectId,
  hueChannelObjectId,
  parseObjectId,
  usbStripObjectId,
  type RoomObjectKind,
  type RoomObjectRef,
} from "../objectId";
import { ROOM_OBJECT_KINDS, roomObjectAdapter, type RoomObjectAdapter } from "../roomObjectKinds";

const config: RoomMapConfig = {
  ...DEFAULT_ROOM_MAP,
  tvAnchor: { x: 1, y: 1, width: 1, height: 0.1 },
  furniture: [{ id: "f1", type: "sofa", x: 0, y: 0, width: 1, height: 1, label: "Sofa", rotation: 350 }],
  usbStrips: [{ stripId: "s1", startX: 0, startY: 0, endX: 2, endY: 0, ledCount: 60 }],
};

describe("ROOM_OBJECT_KINDS", () => {
  it("has exactly one row per object kind", () => {
    const covered: Equals<keyof typeof ROOM_OBJECT_KINDS, RoomObjectKind> = true;
    expect(covered).toBe(true);
    expect(Object.keys(ROOM_OBJECT_KINDS).sort()).toEqual(["furniture", "hue", "image", "tv", "usb"]);
  });

  it("does not compile with a kind missing", () => {
    const { image: _image, ...withoutImage } = ROOM_OBJECT_KINDS;
    // @ts-expect-error — an image layer would have no answer for move, lock or inspect.
    const incomplete = withoutImage satisfies { [K in RoomObjectKind]: RoomObjectAdapter<K> };
    expect(Object.keys(incomplete)).not.toContain("image");
  });

  it("keeps Hue channels undeletable and undupable", () => {
    expect(ROOM_OBJECT_KINDS.hue.remove).toBeNull();
    expect(ROOM_OBJECT_KINDS.hue.duplicate).toBeNull();
  });

  it("dispatches by the parsed id", () => {
    const ref = parseObjectId(usbStripObjectId("s1")) as RoomObjectRef;
    expect(roomObjectAdapter(ref).moveTo(config, ref, 1, 1, { hueAreaId: null })).toEqual({
      usbStrips: [{ stripId: "s1", startX: 1, startY: 1, endX: 3, endY: 1, ledCount: 60 }],
    });
  });

  // The name field is the one way to rename now, so a Hue light renames through its row too — and
  // only the shown area's light of that number.
  it("renames a Hue light in the shown area, leaving another area's same-numbered light alone", () => {
    const twoAreas: RoomMapConfig = {
      ...config,
      hueChannels: [
        { channelIndex: 0, x: 0, y: 0, z: 0, entertainmentAreaId: "a", label: "Lamp A" },
        { channelIndex: 0, x: 0, y: 0, z: 0, entertainmentAreaId: "b", label: "Lamp B" },
      ],
    };
    const ref = parseObjectId(hueChannelObjectId(0)) as RoomObjectRef<"hue">;
    const patch = ROOM_OBJECT_KINDS.hue.rename(twoAreas, ref, "Floor lamp", { hueAreaId: "b" });
    expect(patch.hueChannels?.map((ch) => ch.label)).toEqual(["Lamp A", "Floor lamp"]);
  });

  it("rotates furniture by a step, wrapping at a full turn", () => {
    const ref = parseObjectId(furnitureObjectId("f1")) as RoomObjectRef<"furniture">;
    expect(ROOM_OBJECT_KINDS.furniture.rotateBy(config, ref, 15).furniture?.[0]?.rotation).toBe(5);
  });

  it("stops a nudged or typed piece at the room's walls", () => {
    const ref = parseObjectId(furnitureObjectId("f1")) as RoomObjectRef<"furniture">;
    const far = ROOM_OBJECT_KINDS.furniture.moveTo(config, ref, -5, 0);
    expect(far?.furniture?.[0]?.x).toBeGreaterThanOrEqual(0);
    const atWall = { ...config, furniture: config.furniture.map((f) => ({ ...f, x: 0, rotation: 0 })) };
    expect(ROOM_OBJECT_KINDS.furniture.nudge(atWall, ref, { x: -1, y: 0, coarse: true }).furniture?.[0]?.x).toBe(0);
  });

  it("nudges world objects by 10 cm or a metre, and Hue channels by 0.05 with y up", () => {
    const tv = { kind: "tv" } as const;
    expect(ROOM_OBJECT_KINDS.tv.nudge(config, tv, { x: 1, y: 0, coarse: false }).tvAnchor?.x).toBeCloseTo(1.1);
    expect(ROOM_OBJECT_KINDS.tv.nudge(config, tv, { x: 0, y: 1, coarse: true }).tvAnchor?.y).toBeCloseTo(2);

    const withChannel: RoomMapConfig = {
      ...config,
      hueChannels: [{ channelIndex: 3, x: 0, y: 0, z: 0 } as RoomMapConfig["hueChannels"][number]],
    };
    const hue = parseObjectId(hueChannelObjectId(3)) as RoomObjectRef<"hue">;
    const moved = ROOM_OBJECT_KINDS.hue.nudge(withChannel, hue, { x: 0, y: -1, coarse: true }, { hueAreaId: null });
    expect(moved.hueChannels?.[0]?.y).toBeCloseTo(0.05);
  });
});
