import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ShellState } from "@/shared/contracts/shell";
import type { RoomMapConfig } from "@/shared/contracts/roomMap";
import { DEFAULT_ROOM_MAP } from "@/shared/contracts/roomMap";
import { GESTURE_COALESCE_MS } from "../roomMapReducer";
import { useRoomMapState } from "../useRoomMapState";

const mockLoad = vi.fn();
const mockSave = vi.fn();
// What the store holds: the last load, with every write the hook makes laid over it. `update` runs
// the hook's updater against it and hands the partial to `mockSave`, as the real store writes it.
let stored: ShellState = {} as ShellState;

vi.mock("@/features/persistence/shellStore", () => ({
  shellStore: {
    load: async () => {
      const state = await mockLoad();
      stored = { ...(state ?? {}) };
      return state;
    },
    save: (partial: Partial<ShellState>) => mockSave(partial),
    update: async (fn: (current: ShellState) => Partial<ShellState> | null) => {
      const partial = fn(stored);
      if (partial === null) return stored;
      await mockSave(partial);
      stored = { ...stored, ...partial };
      return stored;
    },
  },
}));

function makePersistedConfig(): RoomMapConfig {
  return {
    dimensions: { widthMeters: 6, depthMeters: 5, heightMeters: 3 },
    hueChannels: [],
    usbStrips: [],
    furniture: [{ id: "f1", type: "sofa", x: 1, y: 2, width: 2, height: 1 }],
    zones: [],
    imageLayers: [],
    tvAnchor: { x: 3, y: 0.5, width: 1.5, height: 0.9 },
  };
}

function roomMapSaves() {
  return mockSave.mock.calls.filter(([partial]) => "roomMap" in (partial as object));
}

beforeEach(() => {
  mockLoad.mockReset();
  mockSave.mockReset();
  mockSave.mockResolvedValue(undefined);
});

describe("useRoomMapState — load", () => {
  it("returns DEFAULT_ROOM_MAP when shellStore has no roomMap", async () => {
    mockLoad.mockResolvedValue({} as ShellState);
    const { result } = renderHook(() => useRoomMapState());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.config).toEqual(DEFAULT_ROOM_MAP);
    expect(result.current.error).toBeNull();
  });

  it("loads the persisted roomMap without writing it back or making it undoable", async () => {
    const persisted = makePersistedConfig();
    mockLoad.mockResolvedValue({ roomMap: persisted } as ShellState);
    const { result } = renderHook(() => useRoomMapState());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.config).toEqual(persisted);
    expect(result.current.canUndo).toBe(false);
    expect(mockSave).not.toHaveBeenCalled();
  });

  it("logs and reports a failed load, and reads the map again on a reload", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mockLoad.mockRejectedValueOnce(new Error("store unavailable"));
    const { result } = renderHook(() => useRoomMapState());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.loadFailed).toBe(true);
    expect(result.current.config).toEqual(DEFAULT_ROOM_MAP);
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("[LumaSync] Room map load failed: store unavailable"),
    );
    consoleError.mockRestore();

    mockLoad.mockResolvedValueOnce({ roomMap: { ...DEFAULT_ROOM_MAP, dimensions: { widthMeters: 7, depthMeters: 4, heightMeters: 2.6 } } });
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.config.dimensions.widthMeters).toBe(7));
    expect(result.current.loadFailed).toBe(false);
  });
});

describe("useRoomMapState — another writer", () => {
  // The USB roster adds a strip on a connect while the editor is open; the editor's next save
  // used to write its own copy of the whole map and take that strip away again.
  it("keeps a strip another writer stored while the editor was open", async () => {
    const own = { stripId: "own", startX: 0, startY: 0, endX: 1, endY: 0, ledCount: 60 };
    const added = { ...own, stripId: "added", portName: "/dev/cu.usbserial-1" };
    mockLoad.mockResolvedValue({ roomMap: { ...makePersistedConfig(), usbStrips: [own] } } as ShellState);
    const { result } = renderHook(() => useRoomMapState());
    await waitFor(() => expect(result.current.loading).toBe(false));
    stored = { ...stored, roomMap: { ...stored.roomMap!, usbStrips: [own, added] } };

    act(() => result.current.apply({ dimensions: { widthMeters: 8, depthMeters: 6, heightMeters: 3 } }));

    await waitFor(() => expect(roomMapSaves()).toHaveLength(1));
    const saved = roomMapSaves()[0][0].roomMap as RoomMapConfig;
    expect(saved.usbStrips.map((strip) => strip.stripId)).toEqual(["own", "added"]);
    expect(saved.dimensions.widthMeters).toBe(8);
  });
});

describe("useRoomMapState — a failed save", () => {
  // A save queued behind one that fails used to write only its own change, against a baseline that
  // never reached the file — the failed edit was lost for good.
  it("makes the next save write the whole map", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mockLoad.mockResolvedValue({ roomMap: makePersistedConfig() } as ShellState);
    const { result } = renderHook(() => useRoomMapState());
    await waitFor(() => expect(result.current.loading).toBe(false));
    mockSave.mockRejectedValueOnce(new Error("disk full"));

    act(() => result.current.apply({ dimensions: { widthMeters: 8, depthMeters: 6, heightMeters: 3 } }));
    act(() => result.current.apply({ furniture: [] }));

    await waitFor(() => expect(roomMapSaves()).toHaveLength(2));
    const second = roomMapSaves()[1][0].roomMap as RoomMapConfig;
    expect(second.dimensions.widthMeters).toBe(8);
    expect(second.furniture).toEqual([]);
    consoleError.mockRestore();
  });
});

describe("useRoomMapState — saving", () => {
  it("saves a plain apply at once", async () => {
    mockLoad.mockResolvedValue({} as ShellState);
    const { result } = renderHook(() => useRoomMapState());
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.apply({ dimensions: { widthMeters: 8, depthMeters: 6, heightMeters: 3 } }));

    await waitFor(() => expect(roomMapSaves()).toHaveLength(1));
    expect(mockSave).toHaveBeenCalledWith(
      expect.objectContaining({
        roomMap: expect.objectContaining({ dimensions: { widthMeters: 8, depthMeters: 6, heightMeters: 3 } }),
      }),
    );
  });

  it("reset restores DEFAULT_ROOM_MAP, dropping the TV rather than merging over it", async () => {
    mockLoad.mockResolvedValue({ roomMap: makePersistedConfig() } as ShellState);
    const { result } = renderHook(() => useRoomMapState());
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.reset());

    expect(result.current.config).toEqual(DEFAULT_ROOM_MAP);
    await waitFor(() =>
      expect(mockSave).toHaveBeenCalledWith(expect.objectContaining({ roomMap: DEFAULT_ROOM_MAP })),
    );
  });

  it("logs and reports a failed save", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mockLoad.mockResolvedValue({} as ShellState);
    mockSave.mockRejectedValue(new Error("disk full"));
    const { result } = renderHook(() => useRoomMapState());
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.reset());

    await waitFor(() => expect(result.current.error).toContain("disk full"));
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("[LumaSync] Room map save failed: disk full"),
    );
    consoleError.mockRestore();
  });

  // The alert said the map was not saved and offered nothing to do about it.
  it("writes the map again on a retry, and clears the error when it lands", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mockLoad.mockResolvedValue({ roomMap: makePersistedConfig() } as ShellState);
    mockSave.mockRejectedValueOnce(new Error("disk full"));
    const { result } = renderHook(() => useRoomMapState());
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.reset());
    await waitFor(() => expect(result.current.error).toContain("disk full"));

    act(() => result.current.retrySave());
    await waitFor(() => expect(result.current.error).toBeNull());
    expect(roomMapSaves()[roomMapSaves().length - 1]?.[0]).toMatchObject({ roomMap: result.current.config });
    consoleError.mockRestore();
  });

  it("adopt saves but leaves nothing to undo", async () => {
    mockLoad.mockResolvedValue({ roomMap: makePersistedConfig() } as ShellState);
    const { result } = renderHook(() => useRoomMapState());
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.adopt({ hueChannels: [{ channelIndex: 0, x: 0, y: 0, z: 0 }] }));

    await waitFor(() => expect(roomMapSaves()).toHaveLength(1));
    expect(result.current.canUndo).toBe(false);
    act(() => result.current.undo());
    expect(result.current.config.hueChannels).toHaveLength(1);
  });
});

describe("useRoomMapState — a gesture is one undo step and one save", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function loadedHook() {
    mockLoad.mockResolvedValue({ roomMap: makePersistedConfig() } as ShellState);
    const hook = renderHook(() => useRoomMapState());
    await act(async () => {
      await Promise.resolve();
    });
    expect(hook.result.current.loading).toBe(false);
    return hook;
  }

  function nudgeSofa(result: { current: ReturnType<typeof useRoomMapState> }, continued: boolean) {
    act(() =>
      result.current.apply(
        (cfg) => ({ furniture: cfg.furniture.map((f) => ({ ...f, x: f.x + 0.1 })) }),
        { gesture: "nudge:furniture-f1", continued },
      ),
    );
  }

  it("holds the save until the gesture goes quiet, then writes once", async () => {
    const { result } = await loadedHook();

    nudgeSofa(result, false);
    for (let i = 0; i < 20; i++) {
      vi.advanceTimersByTime(30);
      nudgeSofa(result, true);
    }
    expect(roomMapSaves()).toHaveLength(0);

    await act(async () => {
      vi.advanceTimersByTime(GESTURE_COALESCE_MS);
    });
    expect(roomMapSaves()).toHaveLength(1);
    expect(roomMapSaves()[0]?.[0].roomMap.furniture[0].x).toBeCloseTo(1 + 21 * 0.1, 10);

    // Undo saves, and the save settles after the call returns.
    await act(async () => result.current.undo());
    expect(result.current.config.furniture[0]?.x).toBe(1);
    expect(result.current.canUndo).toBe(false);
  });

  it("flushes a held save on unmount instead of dropping the last nudge", async () => {
    const { result, unmount } = await loadedHook();
    nudgeSofa(result, false);
    expect(roomMapSaves()).toHaveLength(0);

    unmount();

    expect(roomMapSaves()).toHaveLength(1);
  });

  it("an undo mid-gesture saves at once and cancels the held save", async () => {
    const { result } = await loadedHook();
    nudgeSofa(result, false);
    await act(async () => result.current.undo());
    expect(roomMapSaves()).toHaveLength(1);

    await act(async () => {
      vi.advanceTimersByTime(GESTURE_COALESCE_MS * 2);
    });
    expect(roomMapSaves()).toHaveLength(1);
    expect(roomMapSaves()[0]?.[0].roomMap.furniture[0].x).toBe(1);
  });
});

describe("useRoomMapState — reset", () => {
  // Reset used to write DEFAULT_ROOM_MAP over everything, taking the bridge's
  // channels and zones and the strips Devices had linked to a port with it.
  it("clears what the user placed and keeps what the bridge and Devices own", async () => {
    const persisted: RoomMapConfig = {
      ...makePersistedConfig(),
      hueChannels: [{ channelIndex: 0, channelId: 3, x: 0.2, y: -0.1, z: 0.4 }],
      zones: [
        {
          id: "zone-a",
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
      usbStrips: [
        { stripId: "usb-linked", startX: 1, startY: 1, endX: 4, endY: 1, ledCount: 164, portName: "/dev/cu.test" },
        { stripId: "usb-drawn", startX: 0, startY: 3, endX: 2, endY: 3, ledCount: 30 },
      ],
    };
    mockLoad.mockResolvedValue({ roomMap: persisted } as ShellState);
    const { result } = renderHook(() => useRoomMapState());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => result.current.reset());

    const config = result.current.config;
    expect(config.tvAnchor).toBeUndefined();
    expect(config.furniture).toEqual([]);
    expect(config.dimensions).toEqual(DEFAULT_ROOM_MAP.dimensions);
    expect(config.hueChannels).toEqual(persisted.hueChannels);
    expect(config.zones).toEqual(persisted.zones);
    expect(config.usbStrips.map((s) => s.stripId)).toEqual(["usb-linked"]);
    expect(config.usbStrips[0].ledCount).toBe(164);
    // Still one undoable step.
    expect(result.current.canUndo).toBe(true);
  });
});
