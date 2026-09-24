// `channelIndex` is the index inside the entertainment area, not the array
// slot; room maps written by v1.4.0 and earlier are gapped. See
// docs/architecture/room-map.md.
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_ROOM_MAP, type RoomMapConfig } from "@/shared/contracts/roomMap";
import { furnitureObjectId, hueChannelObjectId } from "../../model/objectId";
import type { RoomMapPatch } from "../roomMapReducer";
import { useRoomMapObjects } from "../useRoomMapObjects";
import type { ApplyOptions } from "../useRoomMapState";

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

function renderObjects(
  config: RoomMapConfig,
  selectedId: string | null = null,
  hueAreaId: string | null = null,
) {
  const apply = vi.fn<(patch: RoomMapPatch, options?: ApplyOptions) => void>();
  const hook = renderHook(() =>
    useRoomMapObjects({
      config,
      hueAreaId,
      apply,
      selectedId,
      select: vi.fn(),
    }),
  );
  /** The config the `index`th apply produces, updater or plain partial alike. */
  const written = (index: number): RoomMapConfig => {
    const patch = apply.mock.calls[index]?.[0];
    if (patch === undefined) throw new Error(`no apply #${index}`);
    return { ...config, ...(typeof patch === "function" ? patch(config) : patch) };
  };
  return { ...hook, apply, written };
}

function arrowEvent(key: string, repeat = false) {
  return { key, shiftKey: false, repeat, preventDefault: vi.fn() } as unknown as React.KeyboardEvent<HTMLDivElement>;
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
    const { result, apply } = renderObjects(cfg, furnitureObjectId("f1"));
    act(() => result.current.handleRotate());
    expect(apply).not.toHaveBeenCalled();
  });

  it("still rotates an unlocked one", () => {
    const cfg = lockedFurniture(false);
    const { result, apply, written } = renderObjects(cfg, furnitureObjectId("f1"));
    act(() => result.current.handleRotate());
    expect(apply).toHaveBeenCalledTimes(1);
    expect(written(0).furniture[0].rotation).toBe(15);
  });

  it("refuses to nudge a locked object", () => {
    const cfg = lockedFurniture(true);
    const { result, apply } = renderObjects(cfg, furnitureObjectId("f1"));
    act(() => result.current.handleArrowNudge(arrowEvent("ArrowRight")));
    expect(apply).not.toHaveBeenCalled();
  });

  it("still nudges an unlocked one", () => {
    const cfg = lockedFurniture(false);
    const { result, apply, written } = renderObjects(cfg, furnitureObjectId("f1"));
    act(() => result.current.handleArrowNudge(arrowEvent("ArrowRight")));
    expect(apply).toHaveBeenCalledTimes(1);
    expect(written(0).furniture[0].x).toBeCloseTo(1.1, 10);
  });

  it("refuses to nudge a locked Hue channel", () => {
    const { result, apply } = renderObjects(gappedConfig(), hueChannelObjectId(2));
    act(() => result.current.handleArrowNudge(arrowEvent("ArrowRight")));
    expect(apply).not.toHaveBeenCalled();
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
    const { result, written } = renderObjects(config, hueChannelObjectId(0));
    act(() => result.current.handleArrowNudge(arrowEvent("ArrowRight")));
    const ch = written(0).hueChannels[0];
    // 0.05 world / 0.5 zone scale = 0.1 relative
    expect(ch?.zoneRelativePosition?.x).toBeCloseTo(0.1, 10);
    expect(ch.x).toBeCloseTo(0.05, 10);
  });

  it("routes handleUpdatePosition through the zone too", () => {
    const { result, written } = renderObjects(config);
    act(() => result.current.handleUpdatePosition(hueChannelObjectId(0), 0.25, 0));
    const ch = written(0).hueChannels[0];
    expect(ch?.zoneRelativePosition?.x).toBeCloseTo(0.5, 10);
  });
});

// `hue-<index>` names no area. Two areas' channel 0 were both hit by a nudge
// and a typed position, and the lock check read whichever came first. See
// docs/architecture/room-map.md.
describe("useRoomMapObjects — Hue channels resolve inside the viewed area", () => {
  const twoAreas: RoomMapConfig = {
    ...DEFAULT_ROOM_MAP,
    hueChannels: [
      { channelIndex: 0, x: -0.5, y: 0, z: 0, entertainmentAreaId: "area-a", locked: true },
      { channelIndex: 0, x: 0.5, y: 0, z: 0, entertainmentAreaId: "area-b", locked: false },
    ],
  };

  it("nudges only the viewed area's channel", () => {
    const { result, written } = renderObjects(twoAreas, hueChannelObjectId(0), "area-b");
    act(() => result.current.handleArrowNudge(arrowEvent("ArrowRight")));
    const [a, b] = written(0).hueChannels;
    expect(a).toEqual(twoAreas.hueChannels[0]);
    expect(b?.x).toBeCloseTo(0.55, 10);
  });

  it("types a position into the viewed area's channel only", () => {
    const { result, written } = renderObjects(twoAreas, null, "area-b");
    act(() => result.current.handleUpdatePosition(hueChannelObjectId(0), 0.1, 0.2));
    const [a, b] = written(0).hueChannels;
    expect(a).toEqual(twoAreas.hueChannels[0]);
    expect(b).toMatchObject({ x: 0.1, y: 0.2 });
  });

  it("reads the lock of the viewed area's channel, not the first match", () => {
    const { result } = renderObjects(twoAreas, null, "area-b");
    expect(result.current.isLocked(hueChannelObjectId(0))).toBe(false);
  });
});

describe("useRoomMapObjects — a held arrow is one gesture per object", () => {
  const cfg: RoomMapConfig = {
    ...DEFAULT_ROOM_MAP,
    furniture: [{ id: "f1", type: "sofa", x: 1, y: 1, width: 2, height: 1 }],
  };

  it("keys the nudge on the selected object and marks auto-repeats as continued", () => {
    const { result, apply } = renderObjects(cfg, furnitureObjectId("f1"));
    act(() => result.current.handleArrowNudge(arrowEvent("ArrowRight")));
    act(() => result.current.handleArrowNudge(arrowEvent("ArrowRight", true)));
    expect(apply.mock.calls[0]?.[1]).toEqual({ gesture: "nudge:furniture-f1", continued: false });
    expect(apply.mock.calls[1]?.[1]).toEqual({ gesture: "nudge:furniture-f1", continued: true });
  });
});
