import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ShellState } from "../../../../shared/contracts/shell";
import type { RoomMapConfig } from "../../../../shared/contracts/roomMap";
import { DEFAULT_ROOM_MAP } from "../../../../shared/contracts/roomMap";
import { useRoomMapPersist } from "./useRoomMapPersist";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockLoad = vi.fn();
const mockSave = vi.fn();

vi.mock("../../../persistence/shellStore", () => ({
  shellStore: {
    load: () => mockLoad(),
    save: (partial: Partial<ShellState>) => mockSave(partial),
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePersistedConfig(): RoomMapConfig {
  return {
    dimensions: { widthMeters: 6, depthMeters: 5, heightMeters: 3 },
    hueChannels: [],
    usbStrips: [],
    furniture: [
      { id: "f1", type: "sofa", x: 1, y: 2, width: 2, height: 1 },
    ],
    zones: [],
    tvAnchor: { x: 3, y: 0.5, width: 1.5, height: 0.9 },
  };
}

// ---------------------------------------------------------------------------
// ROOM-07: useRoomMapPersist — load on mount
// ---------------------------------------------------------------------------

describe("useRoomMapPersist (ROOM-07)", () => {
  beforeEach(() => {
    mockLoad.mockReset();
    mockSave.mockReset();
  });

  it("ROOM-07: returns DEFAULT_ROOM_MAP when shellStore has no roomMap", async () => {
    mockLoad.mockResolvedValue({} as ShellState);

    const { result } = renderHook(() => useRoomMapPersist());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.config).toEqual(DEFAULT_ROOM_MAP);
    expect(result.current.error).toBeNull();
  });

  it("ROOM-07: loads persisted roomMap from shellStore on mount", async () => {
    const persisted = makePersistedConfig();
    mockLoad.mockResolvedValue({ roomMap: persisted, roomMapVersion: 3 } as ShellState);

    const { result } = renderHook(() => useRoomMapPersist());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.config).toEqual(persisted);
    expect(result.current.config.tvAnchor).toEqual({ x: 3, y: 0.5, width: 1.5, height: 0.9 });
    expect(result.current.config.furniture).toHaveLength(1);
    expect(result.current.error).toBeNull();
  });

  it("ROOM-07: sets error when shellStore.load rejects", async () => {
    mockLoad.mockRejectedValue(new Error("store unavailable"));

    const { result } = renderHook(() => useRoomMapPersist());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toContain("store unavailable");
    expect(result.current.config).toEqual(DEFAULT_ROOM_MAP);
  });

  it("ROOM-07: updateConfig merges partial and calls shellStore.save", async () => {
    mockLoad.mockResolvedValue({} as ShellState);
    mockSave.mockResolvedValue(undefined);

    const { result } = renderHook(() => useRoomMapPersist());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await result.current.updateConfig({ dimensions: { widthMeters: 8, depthMeters: 6, heightMeters: 3 } });

    expect(mockSave).toHaveBeenCalledWith(
      expect.objectContaining({
        roomMap: expect.objectContaining({
          dimensions: { widthMeters: 8, depthMeters: 6, heightMeters: 3 },
        }),
        roomMapVersion: 1,
      }),
    );
  });

  it("ROOM-07: resetConfig restores DEFAULT_ROOM_MAP", async () => {
    const persisted = makePersistedConfig();
    mockLoad.mockResolvedValue({ roomMap: persisted } as ShellState);
    mockSave.mockResolvedValue(undefined);

    const { result } = renderHook(() => useRoomMapPersist());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.resetConfig();
    });

    expect(result.current.config).toEqual(DEFAULT_ROOM_MAP);
    expect(mockSave).toHaveBeenCalledWith(
      expect.objectContaining({ roomMap: DEFAULT_ROOM_MAP }),
    );
  });
});
