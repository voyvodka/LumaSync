import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ShellState } from "@/shared/contracts/shell";

const { loadMock, saveMock, savedListeners } = vi.hoisted(() => ({
  loadMock: vi.fn(),
  saveMock: vi.fn(),
  savedListeners: new Set<(saved: Partial<ShellState>) => void>(),
}));

vi.mock("@/features/persistence/shellStore", () => ({
  shellStore: {
    load: () => loadMock(),
    save: (partial: Partial<ShellState>) => saveMock(partial),
    onSaved: (listener: (saved: Partial<ShellState>) => void) => {
      savedListeners.add(listener);
      return () => savedListeners.delete(listener);
    },
  },
}));

import { migrateShellState } from "@/features/persistence/migrations";

import {
  __resetShowNerdStatsForTests,
  setShowNerdStats,
  useShowNerdStats,
} from "../nerdStatsSetting";

/** Renders and lets the hydration read land inside `act`. */
async function mount() {
  const hook = renderHook(() => useShowNerdStats());
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
  return hook;
}

describe("showNerdStats setting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    savedListeners.clear();
    __resetShowNerdStatsForTests();
    loadMock.mockResolvedValue({});
    saveMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    // Unmount first: resetting under a mounted hook is an update outside act.
    cleanup();
    __resetShowNerdStatsForTests();
  });

  it("is off when the key was never stored — new installs and upgraders alike", async () => {
    // A pre-setting file at an old schema: migration adds nothing, and absent reads as off.
    const legacy = migrateShellState({ schemaVersion: 1, lastSection: "lights" } as ShellState);
    expect(legacy.showNerdStats).toBeUndefined();
    loadMock.mockResolvedValue(legacy);

    const { result } = await mount();

    expect(loadMock).toHaveBeenCalled();
    expect(result.current).toBe(false);
  });

  it("follows the stored value", async () => {
    loadMock.mockResolvedValue({ showNerdStats: true });

    const { result } = await mount();

    expect(result.current).toBe(true);
  });

  it("persists a toggle and shows it at once", async () => {
    const { result } = await mount();

    await act(async () => {
      await setShowNerdStats(true);
    });

    expect(result.current).toBe(true);
    expect(saveMock).toHaveBeenCalledWith({ showNerdStats: true });
  });

  it("puts the switch back when the save fails", async () => {
    saveMock.mockRejectedValue(new Error("SHELL_STATE_WRITE_FAILED: disk full"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { result } = await mount();

    await act(async () => {
      await setShowNerdStats(true);
    });

    expect(result.current).toBe(false);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("does not let a late load undo a choice made before it arrived", async () => {
    let resolveLoad: (state: Partial<ShellState>) => void = () => {};
    loadMock.mockReturnValue(
      new Promise((resolve) => {
        resolveLoad = resolve;
      }),
    );
    const { result } = renderHook(() => useShowNerdStats());

    await act(async () => {
      await setShowNerdStats(true);
    });
    await act(async () => {
      resolveLoad({});
    });

    expect(result.current).toBe(true);
  });

  it("follows a write from another window", async () => {
    const { result } = await mount();
    expect(savedListeners.size).toBe(1);

    act(() => {
      for (const listener of savedListeners) listener({ showNerdStats: true });
    });
    expect(result.current).toBe(true);

    act(() => {
      for (const listener of savedListeners) listener({ language: "tr" });
    });
    expect(result.current).toBe(true);
  });
});
