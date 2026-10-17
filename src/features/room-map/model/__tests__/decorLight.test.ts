import { describe, expect, it } from "vitest";

import { DEFAULT_ROOM_MAP, type HueChannelPlacement, type RoomMapConfig, type RoomStructure } from "@/shared/contracts/roomMap";

import { decorLightHeight, driveDecorWithHue, findDecorLight, moveDecorLight, setDecorLightHeight, updateDecorLight } from "../decorLight";
import { PENDANT_DROP_M } from "../hueHang";
import { resolveHueChannelWorld, resolveHueChannelWorldZ } from "../hueChannelPosition";

const pendant = { id: "dining", kind: "light", x: 1, y: 3, fixture: "pendant" } as const;
const config = (structures: unknown[], hueChannels: HueChannelPlacement[] = []): RoomMapConfig => ({
  ...DEFAULT_ROOM_MAP,
  dimensions: { widthMeters: 5, depthMeters: 4, heightMeters: 2.5 },
  structures: structures as RoomStructure[],
  hueChannels,
});

describe("decor lights", () => {
  it("hangs where its fixture hangs until it is given a drop", () => {
    expect(decorLightHeight(pendant, 2.5)).toBeCloseTo(2.5 - PENDANT_DROP_M);
    expect(decorLightHeight({ ...pendant, dropMeters: 0.4 }, 2.5)).toBeCloseTo(2.1);
    expect(decorLightHeight({ ...pendant, dropMeters: 9 }, 2.5)).toBe(0.3);
  });

  // `structures` is edited by id on the stored array: what this build cannot read survives.
  it("edits the stored entry by id, keeping a newer build's fields and kinds", () => {
    const newer = { id: "sky", kind: "skylight", x: 2, y: 2 };
    const patch = updateDecorLight(config([newer, { ...pendant, glow: "soft" }]), "dining", { label: "Table" });
    expect(patch?.structures).toEqual([newer, { ...pendant, glow: "soft", label: "Table" }]);
  });

  it("finds only a light, and edits nothing for an id that is not one", () => {
    const column = { id: "c", kind: "column", x: 1, y: 1, width: 0.3, depth: 0.3 };
    expect(findDecorLight(config([column]), "c")).toBeNull();
    expect(updateDecorLight(config([column]), "c", { label: "x" })).toBeNull();
  });

  it("moves inside the room and stores a height as its drop below the ceiling", () => {
    const room = config([pendant]);
    expect(moveDecorLight(room, "dining", 7, -1)?.structures?.[0]).toMatchObject({ x: 5, y: 0 });
    expect(setDecorLightHeight(room, "dining", 2)?.structures?.[0]).toMatchObject({ dropMeters: 0.5 });
    expect(setDecorLightHeight(room, "dining", 0)?.structures?.[0]).toMatchObject({ dropMeters: 2.2 });
  });

  describe("driven with a Hue light", () => {
    const channel: HueChannelPlacement = { channelIndex: 2, x: 0.5, y: 0.5, z: 0 };

    it("puts the light where the lamp is, as high and as the same fixture, and takes the lamp away", () => {
      const patch = driveDecorWithHue(config([pendant], [channel]), "dining", channel)!;
      const moved = patch.hueChannels![0]!;
      // x 1 of 5 m is -0.6 in the cube; y 3 of 4 m from the TV wall is -0.5.
      expect(moved).toMatchObject({ channelIndex: 2, fixture: "pendant", zOrigin: "user" });
      expect(moved.x).toBeCloseTo(-0.6);
      expect(moved.y).toBeCloseTo(-0.5);
      expect(moved.z).toBeCloseTo(((2.5 - PENDANT_DROP_M) / 2.5) * 2 - 1);
      expect(patch.structures).toEqual([]);
    });

    it("takes a zone's light out of its zone when the lamp is outside it", () => {
      const zone = { id: "z", name: "Sofa", entertainmentAreaId: "area", centerX: 0.6, centerY: 0.6, centerZ: 0, scaleX: 0.2, scaleY: 0.2, scaleZ: 0.2, channelIndices: [2] };
      const bound = { ...channel, zoneId: "z", zoneRelativePosition: { x: 0, y: 0, z: 0 } };
      const room: RoomMapConfig = { ...config([pendant], [bound]), zones: [zone] };
      const moved = driveDecorWithHue(room, "dining", bound)!.hueChannels![0]!;
      expect(moved.zoneId).toBeUndefined();
      expect(resolveHueChannelWorld(moved, room.zones).x).toBeCloseTo(-0.6);
      expect(resolveHueChannelWorldZ(moved, room.zones)).toBeCloseTo(((2.5 - PENDANT_DROP_M) / 2.5) * 2 - 1);
    });

    it("does nothing with a locked light", () => {
      const locked = { ...channel, locked: true };
      expect(driveDecorWithHue(config([pendant], [locked]), "dining", locked)).toBeNull();
    });
  });
});
