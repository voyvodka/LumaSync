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

describe("duplicating a strip", () => {
  it("leaves the port with the original", () => {
    const linked: RoomMapConfig = { ...config, usbStrips: [{ ...config.usbStrips[0]!, portName: "/dev/cu.usbserial-1" }] };
    const copy = ROOM_OBJECT_KINDS.usb.duplicate!(linked, { kind: "usb", stripId: "s1" }, 0.3)!.patch.usbStrips![1]!;
    expect(copy).not.toHaveProperty("portName");
    expect(copy.startX).toBeCloseTo(0.3);
  });
});

describe("moving the TV by key or by typed position", () => {
  // Left behind, the strip stopped counting as the screen's backlight.
  it("takes its backlight with it", () => {
    const behind = { stripId: "bl", startX: 1, startY: 1.15, endX: 2, endY: 1.15, ledCount: 40 };
    const withBacklight: RoomMapConfig = { ...config, usbStrips: [...config.usbStrips, behind] };
    const tv = { kind: "tv" } as const;
    const nudged = ROOM_OBJECT_KINDS.tv.nudge(withBacklight, tv, { x: 1, y: 0, coarse: true });
    expect(nudged.usbStrips?.[1]).toMatchObject({ startX: 2, endX: 3 });
    expect(nudged.usbStrips?.[0]).toBe(config.usbStrips[0]);
    expect(ROOM_OBJECT_KINDS.tv.moveTo(withBacklight, tv, 1.5, 1)?.usbStrips?.[1]).toMatchObject({ startX: 1.5 });
  });
});

describe("removing the bound backlight strip", () => {
  it("takes the screen's binding with it, and leaves another strip's alone", () => {
    const config: RoomMapConfig = {
      ...DEFAULT_ROOM_MAP,
      tvAnchor: { x: 1, y: 0, width: 1, height: 0.1, backlightStripId: "a" },
      usbStrips: [
        { stripId: "a", startX: 1, startY: 0.1, endX: 2, endY: 0.1, ledCount: 30 },
        { stripId: "b", startX: 0, startY: 3, endX: 1, endY: 3, ledCount: 30 },
      ],
    };
    const removeA = ROOM_OBJECT_KINDS.usb.remove!(config, { kind: "usb", stripId: "a" });
    expect(removeA.tvAnchor?.backlightStripId).toBeUndefined();
    expect(removeA.tvAnchor).toMatchObject({ x: 1, width: 1 });
    expect(ROOM_OBJECT_KINDS.usb.remove!(config, { kind: "usb", stripId: "b" }).tvAnchor).toBeUndefined();
  });
});
