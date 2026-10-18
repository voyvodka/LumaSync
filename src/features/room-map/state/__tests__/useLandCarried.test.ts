import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_ROOM_MAP, type RoomMapConfig } from "@/shared/contracts/roomMap";

import { furnitureObjectId, hueChannelObjectId } from "../../model/objectId";
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

describe("useLandCarried — a light let go", () => {
  const lit: RoomMapConfig = { ...config, hueChannels: [{ channelIndex: 2, x: -0.5, y: 0.5, z: 0 }] };

  it("is offered to `dropInto` where it landed, and written only when that declines it", () => {
    const apply = vi.fn<RoomMapDocument["apply"]>();
    const dropInto = vi.fn((_: unknown) => true);
    const { result, rerender } = renderHook(({ take }) => useLandCarried({ apply, config: lit, hueAreaId: null, scopedConfig: lit }, (ch) => dropInto(ch) && take), {
      initialProps: { take: true },
    });
    expect(result.current(hueChannelObjectId(2), 1, 0, 0)).toBe(true);
    // 1 m right of a 4 m room's middle is x 0.5 of the bridge cube.
    expect(dropInto.mock.calls[0]?.[0]).toMatchObject({ channelIndex: 2, x: 0.5 });
    expect(apply).not.toHaveBeenCalled();
    rerender({ take: false });
    expect(result.current(hueChannelObjectId(2), 1, 0, 0)).toBe(true);
    expect(apply).toHaveBeenCalledTimes(1);
  });
});
