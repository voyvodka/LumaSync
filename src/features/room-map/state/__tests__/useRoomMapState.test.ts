import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ShellState } from "@/shared/contracts/shell";
import type { RoomMapConfig } from "@/shared/contracts/roomMap";
import { DEFAULT_ROOM_MAP } from "@/shared/contracts/roomMap";
import { GESTURE_COALESCE_MS } from "../roomMapReducer";
import { useRoomMapState } from "../useRoomMapState";

const mockLoad = vi.fn();
const mockSave = vi.fn();

vi.mock("@/features/persistence/shellStore", () => ({
  shellStore: {
    load: () => mockLoad(),
    save: (partial: Partial<ShellState>) => mockSave(partial),
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
    mockLoad.mockResolvedValue({ roomMap: persisted, roomMapVersion: 3 } as ShellState);
    const { result } = renderHook(() => useRoomMapState());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.config).toEqual(persisted);
    expect(result.current.canUndo).toBe(false);
    expect(mockSave).not.toHaveBeenCalled();
  });

  it("logs and reports a failed load", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mockLoad.mockRejectedValue(new Error("store unavailable"));
    const { result } = renderHook(() => useRoomMapState());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toContain("store unavailable");
    expect(result.current.config).toEqual(DEFAULT_ROOM_MAP);
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("[LumaSync] Room map load failed: store unavailable"),
    );
    consoleError.mockRestore();
  });
});

describe("useRoomMapState — saving", () => {
  it("saves a plain apply at once, with the next version", async () => {
    mockLoad.mockResolvedValue({ roomMapVersion: 3 } as ShellState);
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

    act(() => result.current.undo());
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
    act(() => result.current.undo());
    expect(roomMapSaves()).toHaveLength(1);

    await act(async () => {
      vi.advanceTimersByTime(GESTURE_COALESCE_MS * 2);
    });
    expect(roomMapSaves()).toHaveLength(1);
    expect(roomMapSaves()[0]?.[0].roomMap.furniture[0].x).toBe(1);
  });
});
