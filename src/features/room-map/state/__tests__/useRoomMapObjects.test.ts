// `channelIndex` is the index inside the entertainment area, not the array
// slot; room maps written by v1.4.0 and earlier are gapped. See
// docs/architecture/room-map.md.
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_ROOM_MAP, type RoomMapConfig } from "@/shared/contracts/roomMap";
import { furnitureObjectId, hueChannelObjectId } from "../../model/objectId";
import { useRoomMapObjects } from "../useRoomMapObjects";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

/** Array order deliberately disagrees with `channelIndex` on every entry. */
function gappedConfig(): RoomMapConfig {
  return {
    ...DEFAULT_ROOM_MAP,
    hueChannels: [
      { channelIndex: 2, x: 0.2, y: 0.2, z: 0, locked: true },
      { channelIndex: 0, x: -0.5, y: -0.5, z: 0, locked: false },
    ],
  };
}

function renderObjects(config: RoomMapConfig, selectedId: string | null = null) {
  const updateConfig = vi.fn().mockResolvedValue(undefined);
  const hook = renderHook(() =>
    useRoomMapObjects({
      config,
      updateConfig,
      selectedId,
      setSelectedId: vi.fn(),
    }),
  );
  return { ...hook, updateConfig };
}

function arrowEvent(key: string) {
  return { key, shiftKey: false, preventDefault: vi.fn() } as unknown as React.KeyboardEvent<HTMLDivElement>;
}

describe("useRoomMapObjects — isLocked resolves Hue channels by identity", () => {
  it("reports the lock state of the channel with the matching channelIndex", () => {
    const { result } = renderObjects(gappedConfig());

    expect(result.current.isLocked(hueChannelObjectId(2))).toBe(true);
    expect(result.current.isLocked(hueChannelObjectId(0))).toBe(false);
  });

  it("reports unlocked for a channelIndex that is not in the config", () => {
    const { result } = renderObjects(gappedConfig());

    expect(result.current.isLocked(hueChannelObjectId(1))).toBe(false);
  });
});

// `deleteById` has always checked `isLocked`; rotate and nudge did not, so a
// locked object was still keyboard-movable and rotatable.
describe("useRoomMapObjects — the lock covers every mutator, not just delete", () => {
  function lockedFurniture(locked: boolean): RoomMapConfig {
    return {
      ...DEFAULT_ROOM_MAP,
      furniture: [
        { id: "f1", type: "sofa", x: 1, y: 1, width: 2, height: 1, rotation: 0, locked },
      ],
    };
  }

  it("refuses to rotate a locked object", () => {
    const cfg = lockedFurniture(true);
    const { result, updateConfig } = renderObjects(cfg, furnitureObjectId("f1"));
    act(() => result.current.handleRotate());
    expect(updateConfig).not.toHaveBeenCalled();
  });

  it("still rotates an unlocked one", () => {
    const cfg = lockedFurniture(false);
    const { result, updateConfig } = renderObjects(cfg, furnitureObjectId("f1"));
    act(() => result.current.handleRotate());
    expect(updateConfig).toHaveBeenCalledTimes(1);
    expect(updateConfig.mock.calls[0][0].furniture[0].rotation).toBe(15);
  });

  it("refuses to nudge a locked object", () => {
    const cfg = lockedFurniture(true);
    const { result, updateConfig } = renderObjects(cfg, furnitureObjectId("f1"));
    act(() => result.current.handleArrowNudge(arrowEvent("ArrowRight")));
    expect(updateConfig).not.toHaveBeenCalled();
  });

  it("still nudges an unlocked one", () => {
    const cfg = lockedFurniture(false);
    const { result, updateConfig } = renderObjects(cfg, furnitureObjectId("f1"));
    act(() => result.current.handleArrowNudge(arrowEvent("ArrowRight")));
    expect(updateConfig).toHaveBeenCalledTimes(1);
    expect(updateConfig.mock.calls[0][0].furniture[0].x).toBeCloseTo(1.1, 10);
  });

  it("refuses to nudge a locked Hue channel", () => {
    const { result, updateConfig } = renderObjects(gappedConfig(), hueChannelObjectId(2));
    act(() => result.current.handleArrowNudge(arrowEvent("ArrowRight")));
    expect(updateConfig).not.toHaveBeenCalled();
  });
});

// A zone-bound channel renders from `zoneRelativePosition`; nudging used to
// write the absolute pair the canvas ignores, so nothing moved.
describe("useRoomMapObjects — nudging a zone-bound Hue channel", () => {
  const config: RoomMapConfig = {
    ...DEFAULT_ROOM_MAP,
    zones: [
      {
        id: "z1",
        name: "Sofa",
        entertainmentAreaId: "area-1",
        centerX: 0,
        centerY: 0,
        centerZ: 0,
        scaleX: 0.5,
        scaleY: 0.5,
        scaleZ: 0.5,
        channelIndices: [0],
        borderColor: "#3b82f6",
      },
    ],
    hueChannels: [
      { channelIndex: 0, x: 0, y: 0, z: 0, zoneId: "z1", zoneRelativePosition: { x: 0, y: 0, z: 0 } },
    ],
  };

  it("moves the zone-relative coordinate the canvas reads", () => {
    const { result, updateConfig } = renderObjects(config, hueChannelObjectId(0));
    act(() => result.current.handleArrowNudge(arrowEvent("ArrowRight")));
    const ch = updateConfig.mock.calls[0][0].hueChannels[0];
    // 0.05 world / 0.5 zone scale = 0.1 relative
    expect(ch.zoneRelativePosition.x).toBeCloseTo(0.1, 10);
    expect(ch.x).toBeCloseTo(0.05, 10);
  });

  it("routes handleUpdatePosition through the zone too", () => {
    const { result, updateConfig } = renderObjects(config);
    act(() => result.current.handleUpdatePosition(hueChannelObjectId(0), 0.25, 0));
    const ch = updateConfig.mock.calls[0][0].hueChannels[0];
    expect(ch.zoneRelativePosition.x).toBeCloseTo(0.5, 10);
  });
});
