import { describe, expect, it } from "vitest";

import { FIRST_ROOM_ID, ROOM_LAYOUTS_MAX, type StoredRoomLayouts } from "@/shared/contracts/roomLayouts";
import { DEFAULT_ROOM_MAP, type HueChannelPlacement, type HueZone, type RoomMapConfig } from "@/shared/contracts/roomMap";

import { addRoom, deleteRoom, normalizeRoomLayouts, reconcileRoomSwitch, renameRoom, switchRoom } from "../roomLayouts";

const room = (patch: Partial<RoomMapConfig> = {}): RoomMapConfig => ({ ...DEFAULT_ROOM_MAP, ...patch });
const light = (channelIndex: number, patch: Partial<HueChannelPlacement> = {}): HueChannelPlacement => ({
  channelIndex,
  entertainmentAreaId: "area-1",
  channelId: channelIndex + 10,
  x: 0,
  y: 0,
  z: 0,
  ...patch,
});
const zone = (id: string, channelIndices: number[], patch: Partial<HueZone> = {}): HueZone => ({
  id,
  name: id,
  entertainmentAreaId: "area-1",
  centerX: 0,
  centerY: 0,
  centerZ: 0,
  // A 2 m cube in the 5 × 4 × 2.5 m default room.
  scaleX: 0.4,
  scaleY: 0.5,
  scaleZ: 0.8,
  channelIndices,
  borderColor: "#fff",
  ...patch,
});
let minted = 0;
const newStripId = () => `minted-${++minted}`;

describe("normalizeRoomLayouts", () => {
  it("reads a file from before layouts as its one room", () => {
    expect(normalizeRoomLayouts(undefined)).toEqual({ activeId: FIRST_ROOM_ID, rooms: [{ id: FIRST_ROOM_ID }] });
    expect(normalizeRoomLayouts({ activeId: 3, rooms: "x" })).toEqual({ activeId: FIRST_ROOM_ID, rooms: [{ id: FIRST_ROOM_ID }] });
  });

  it("keeps roomMap as the active room and drops what cannot be read", () => {
    const stored = {
      activeId: "a",
      rooms: [
        { id: "a", name: "  Salon  ", config: room() },
        { id: "b", name: "", config: room() },
        { id: "c" },
        { id: "b", config: room({ furniture: [] }) },
        { id: 4 },
      ],
    };
    expect(normalizeRoomLayouts(stored)).toEqual({ activeId: "a", rooms: [{ id: "a", name: "Salon" }, { id: "b", config: room() }] });
  });

  it("brings back an active room the list lost, and keeps it when cutting to the limit", () => {
    const many = Array.from({ length: ROOM_LAYOUTS_MAX + 3 }, (_, i) => ({ id: `r${i}`, config: room() }));
    const read = normalizeRoomLayouts({ activeId: "lost", rooms: many });
    expect(read.rooms).toHaveLength(ROOM_LAYOUTS_MAX);
    expect(read.rooms[0]).toEqual({ id: "lost" });
  });
});

describe("reconcileRoomSwitch", () => {
  it("takes the other room's layout and places the current lights where it placed them", () => {
    const current = room({ hueChannels: [light(0, { x: 0.1 }), light(1, { x: 0.2 })] });
    const target = room({
      dimensions: { widthMeters: 6, depthMeters: 5, heightMeters: 2.7 },
      furniture: [{ id: "bed", type: "bed", x: 1, y: 1, width: 1.6, height: 2 }],
      hueChannels: [light(0, { x: -0.7, y: 0.4, z: 0.3, label: "Lamp", fixture: "floorLamp" }), light(7, { x: 0.9 })],
    });
    const next = reconcileRoomSwitch(current, target, newStripId);
    expect(next.dimensions.widthMeters).toBe(6);
    expect(next.furniture.map((f) => f.id)).toEqual(["bed"]);
    // The bridge's set: channel 7 is gone from it, channel 1 the other room never placed.
    expect(next.hueChannels.map((c) => c.channelIndex)).toEqual([0, 1]);
    expect(next.hueChannels[0]).toMatchObject({ x: -0.7, y: 0.4, z: 0.3, label: "Lamp", fixture: "floorLamp", channelId: 10 });
    expect(next.hueChannels[1]!.x).toBe(0.2);
  });

  it("matches a light by the bridge's id when its ordinal moved", () => {
    const current = room({ hueChannels: [light(0, { channelId: 20, x: 0 })] });
    const target = room({ hueChannels: [light(3, { channelId: 20, x: 0.6 }), light(0, { channelId: 99, x: -0.6 })] });
    expect(reconcileRoomSwitch(current, target, newStripId).hueChannels[0]!.x).toBe(0.6);
  });

  it("keeps another area's same-numbered light apart", () => {
    const current = room({ hueChannels: [light(0, { entertainmentAreaId: "area-2", channelId: null, x: 0.3 })] });
    const target = room({ hueChannels: [light(0, { channelId: null, x: -0.9 })] });
    expect(reconcileRoomSwitch(current, target, newStripId).hueChannels[0]!.x).toBe(0.3);
  });

  it("renumbers the other room's zones onto the current lights, and unbinds a light from a zone it lacks", () => {
    const currentZone = zone("z-old", [1], { centerX: 0.5, scaleX: 0.2 });
    const current = room({
      hueChannels: [light(4, { channelId: 30 }), light(1, { zoneId: "z-old", zoneRelativePosition: { x: 1, y: 0, z: 0 } })],
      zones: [currentZone],
    });
    const target = room({
      hueChannels: [light(2, { channelId: 30, zoneId: "z-new", zoneRelativePosition: { x: 0, y: 0, z: 0 } })],
      zones: [zone("z-new", [2, 5])],
    });
    const next = reconcileRoomSwitch(current, target, newStripId);
    expect(next.zones).toEqual([zone("z-new", [4])]);
    expect(next.hueChannels[0]).toMatchObject({ channelIndex: 4, zoneId: "z-new" });
    const loose = next.hueChannels[1]!;
    expect(loose.zoneId).toBeUndefined();
    expect(loose.zoneRelativePosition).toBeUndefined();
    // Where the zone had it: its right edge.
    expect(loose.x).toBeCloseTo(0.7);
  });

  it("makes a kept room's zone a cube in metres when an older build wrote it otherwise", () => {
    // 1.5 × 2.4 × 2.5 m: the middle side, 2.4 m, on every side.
    const target = room({ zones: [zone("z-old", [], { scaleX: 0.3, scaleY: 0.6, scaleZ: 1 })] });
    const [cubed] = reconcileRoomSwitch(room({}), target, newStripId).zones;
    expect([cubed!.scaleX, cubed!.scaleY, cubed!.scaleZ].map((v) => Number(v.toFixed(6)))).toEqual([0.48, 0.6, 0.96]);
  });

  it("keeps the plugged-in strip's identity and takes the other room's placement of its port", () => {
    const current = room({
      usbStrips: [{ stripId: "s-live", portName: "/dev/a", ledCount: 120, ledsPerMeter: 60, startX: 0, startY: 0, endX: 1, endY: 0 }],
    });
    const target = room({
      tvAnchor: { x: 1, y: 0, width: 1.2, height: 0.08, backlightStripId: "s-old" },
      usbStrips: [
        { stripId: "s-old", portName: "/dev/a", ledCount: 60, startX: 2, startY: 0.1, endX: 3, endY: 0.1, mountHeightMeters: 1 },
        { stripId: "s-live", startX: 0, startY: 2, endX: 1, endY: 2, ledCount: 30 },
        { stripId: "s-gone", portName: "/dev/b", startX: 0, startY: 3, endX: 1, endY: 3, ledCount: 30 },
      ],
    });
    const next = reconcileRoomSwitch(current, target, newStripId);
    expect(next.usbStrips[0]).toEqual({
      stripId: "s-live",
      portName: "/dev/a",
      ledCount: 120,
      ledsPerMeter: 60,
      startX: 2,
      startY: 0.1,
      endX: 3,
      endY: 0.1,
      mountHeightMeters: 1,
    });
    // A drawn strip whose id the live one holds takes a new one; a port no longer plugged in is let go.
    expect(next.usbStrips[1]!.stripId).toMatch(/^minted-/);
    expect(next.usbStrips[2]).not.toHaveProperty("portName");
    expect(next.tvAnchor?.backlightStripId).toBe("s-live");
  });

  it("leaves a plugged-in strip where it is when the other room never placed its port", () => {
    const live = { stripId: "s-live", portName: "/dev/a", ledCount: 120, startX: 0, startY: 0, endX: 1, endY: 0 };
    expect(reconcileRoomSwitch(room({ usbStrips: [live] }), room(), newStripId).usbStrips).toEqual([live]);
  });
});

describe("room operations", () => {
  const layouts: StoredRoomLayouts = { activeId: "a", rooms: [{ id: "a", name: "Salon" }, { id: "b", config: room({ furniture: [] }) }] };
  const current = room({ tvAnchor: { x: 1, y: 0, width: 1, height: 0.1 } });

  it("stores the room left behind and makes the other one roomMap", () => {
    const write = switchRoom(layouts, current, "b", newStripId)!;
    expect(write.roomLayouts).toEqual({ activeId: "b", rooms: [{ id: "a", name: "Salon", config: current }, { id: "b" }] });
    expect(write.roomMap.tvAnchor).toBeUndefined();
    expect(switchRoom(layouts, current, "a", newStripId)).toBeNull();
    expect(switchRoom(layouts, current, "nope", newStripId)).toBeNull();
  });

  it("adds a room as the active one, up to the limit", () => {
    const write = addRoom(layouts, current, { id: "c", name: "Ofis", config: room() })!;
    expect(write.roomLayouts.activeId).toBe("c");
    expect(write.roomLayouts.rooms.map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(write.roomLayouts.rooms[0]!.config).toBe(current);
    const full: StoredRoomLayouts = { activeId: "r0", rooms: Array.from({ length: ROOM_LAYOUTS_MAX }, (_, i) => ({ id: `r${i}`, config: room() })) };
    expect(addRoom(full, current, { id: "x", config: room() })).toBeNull();
  });

  it("renames, and a blank name goes back to the default", () => {
    expect(renameRoom(layouts, "a", "  Oturma odası ")!.rooms[0]).toEqual({ id: "a", name: "Oturma odası" });
    expect(renameRoom(layouts, "a", "   ").rooms[0]).toEqual({ id: "a" });
  });

  it("never deletes the active room or the last one", () => {
    expect(deleteRoom(layouts, "a")).toBeNull();
    expect(deleteRoom(layouts, "b")!.rooms).toEqual([{ id: "a", name: "Salon" }]);
    expect(deleteRoom({ activeId: "a", rooms: [{ id: "a" }] }, "a")).toBeNull();
  });
});
