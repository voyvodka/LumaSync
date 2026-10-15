import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_ROOM_MAP, type RoomMapConfig } from "@/shared/contracts/roomMap";

import { furnitureObjectId } from "../../model/objectId";
import { useLandCarried } from "../useLandCarried";
import type { RoomMapDocument } from "../useRoomMapDocument";

const config: RoomMapConfig = {
  ...DEFAULT_ROOM_MAP,
  dimensions: { widthMeters: 4, depthMeters: 4, heightMeters: 2.5 },
  furniture: [
    { id: "sofa", type: "sofa", x: 1, y: 1, width: 2, height: 0.9 },
    { id: "bed", type: "bed", x: 0, y: 2, width: 1.6, height: 2, locked: true },
  ],
};

describe("useLandCarried", () => {
  // The 3D room puts a piece back where it was picked up when it is told the landing was refused.
  it("says whether the piece was put down, and writes only when it was", () => {
    const apply = vi.fn<RoomMapDocument["apply"]>();
    const { result } = renderHook(() => useLandCarried({ apply, config, hueAreaId: null, scopedConfig: config }));
    expect(result.current(furnitureObjectId("bed"), 0, 0, 0)).toBe(false);
    expect(apply).not.toHaveBeenCalled();
    expect(result.current(furnitureObjectId("sofa"), 0.5, 0, 0)).toBe(true);
    expect(apply).toHaveBeenCalledTimes(1);
  });
});
