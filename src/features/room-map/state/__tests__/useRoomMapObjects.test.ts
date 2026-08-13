// `channelIndex` is the index inside the entertainment area, not the array
// slot; room maps written by v1.4.0 and earlier are gapped. See
// docs/architecture/room-map.md.
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_ROOM_MAP, type RoomMapConfig } from "@/shared/contracts/roomMap";
import { hueChannelObjectId } from "../../model/objectId";
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

function renderObjects(config: RoomMapConfig) {
  return renderHook(() =>
    useRoomMapObjects({
      config,
      updateConfig: vi.fn().mockResolvedValue(undefined),
      selectedId: null,
      setSelectedId: vi.fn(),
    }),
  );
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
