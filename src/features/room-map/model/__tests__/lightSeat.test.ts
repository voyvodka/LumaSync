import { describe, expect, it } from "vitest";

import { DEFAULT_ROOM_MAP, type HueChannelPlacement, type RoomMapConfig } from "@/shared/contracts/roomMap";

import { planMetresToHue } from "../hueChannelPosition";
import { lightHeightMetres, pieceUnder, seatMovedLight } from "../lightSeat";

const room: RoomMapConfig = {
  ...DEFAULT_ROOM_MAP,
  furniture: [{ id: "desk", type: "table", variant: "desk", x: 1, y: 1, width: 1.2, height: 0.6 }],
};
const { widthMeters: W, depthMeters: D, heightMeters: H } = room.dimensions;
const at = (x: number, y: number, metres: number): HueChannelPlacement => ({
  channelIndex: 0,
  ...planMetresToHue(x, y, W, D),
  z: (metres / H) * 2 - 1,
});
const moved = (from: HueChannelPlacement, x: number, y: number): HueChannelPlacement => ({ ...from, ...planMetresToHue(x, y, W, D) });

describe("seatMovedLight", () => {
  it("finds the desk under a point and nothing over the floor", () => {
    expect(pieceUnder(room, 1.6, 1.3)?.item.id).toBe("desk");
    expect(pieceUnder(room, 3.5, 3)).toBeNull();
  });

  // A lamp set on a desk was left at floor height, inside the desk, until its height was typed in.
  it("stands a light from the floor on the desk it is moved onto, and back on the floor off it", () => {
    const onFloor = at(3, 3, 0.05);
    const onDesk = seatMovedLight(onFloor, moved(onFloor, 1.6, 1.3), room);
    const top = pieceUnder(room, 1.6, 1.3)!.top;
    expect(lightHeightMetres(onDesk, room)).toBeCloseTo(top + 0.05);
    expect(lightHeightMetres(seatMovedLight(onDesk, moved(onDesk, 3, 3), room), room)).toBeCloseTo(0.05);
  });

  it("leaves a light hung above both where it was", () => {
    const pendant = at(3, 3, 2);
    expect(lightHeightMetres(seatMovedLight(pendant, moved(pendant, 1.6, 1.3), room), room)).toBeCloseTo(2);
  });
});
