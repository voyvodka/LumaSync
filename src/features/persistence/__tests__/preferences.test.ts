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
  __resetPreferencesForTests,
  followPreference,
  hydratePreferences,
  setPreference,
  usePreference,
} from "../preferences";

/** Renders and lets the hydration read land inside `act`. */
async function mount() {
  const hook = renderHook(() => usePreference("showNerdStats"));
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
  return hook;
}

describe("preferences: showNerdStats", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    savedListeners.clear();
    __resetPreferencesForTests();
    loadMock.mockResolvedValue({});
    saveMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    // Unmount first: resetting under a mounted hook is an update outside act.
    cleanup();
    __resetPreferencesForTests();
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
      await setPreference("showNerdStats", true);
    });

    expect(result.current).toBe(true);
    expect(saveMock).toHaveBeenCalledWith({ showNerdStats: true });
  });

  // The shell's persist-failure notice says a change lasts until quit.
  it("keeps the choice for the session, and logs, when the save fails", async () => {
    saveMock.mockRejectedValue(new Error("SHELL_STATE_WRITE_FAILED: disk full"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { result } = await mount();

    await act(async () => {
      await setPreference("showNerdStats", true);
    });

    expect(result.current).toBe(true);
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
    const { result } = renderHook(() => usePreference("showNerdStats"));

    await act(async () => {
      await setPreference("showNerdStats", true);
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

  it("keeps a key another window did not write", async () => {
    loadMock.mockResolvedValue({ showNerdStats: true, motion: "reduce" });
    const { result } = await mount();

    act(() => {
      for (const listener of savedListeners) listener({ motion: "system" });
    });

    expect(result.current).toBe(true);
  });
});

describe("preferences: motion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    savedListeners.clear();
    __resetPreferencesForTests();
    saveMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    __resetPreferencesForTests();
  });

  it("follows the OS when absent or unrecognised", () => {
    hydratePreferences({ motion: "sideways" as never });
    const { result } = renderHook(() => usePreference("motion"));

    expect(result.current).toBe("system");
    expect(loadMock).not.toHaveBeenCalled();
  });

  it("takes a state this window already read, without reading again", () => {
    hydratePreferences({ motion: "reduce" });
    const { result } = renderHook(() => usePreference("motion"));

    expect(result.current).toBe("reduce");
    expect(loadMock).not.toHaveBeenCalled();
  });

  it("tells a follower outside React about a change, once", async () => {
    hydratePreferences({});
    const seen: string[] = [];
    const stop = followPreference("motion", (value) => seen.push(value));

    await setPreference("motion", "reduce");
    await setPreference("motion", "reduce");
    act(() => {
      for (const listener of savedListeners) listener({ motion: undefined });
    });
    stop();

    expect(seen).toEqual(["reduce", "system"]);
    expect(saveMock).toHaveBeenCalledWith({ motion: "reduce" });
  });
});

describe("preferences: updateChannel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    savedListeners.clear();
    __resetPreferencesForTests();
    saveMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    __resetPreferencesForTests();
  });

  it("opens on the stored channel from the boot read, whatever the build's default", () => {
    hydratePreferences({ updateChannel: "stable" });
    const { result } = renderHook(() => usePreference("updateChannel"));

    expect(result.current).toBe("stable");
  });

  // Rust reads the stored channel to pick the feed: a switch showing an unsaved choice would lie.
  it("puts the old channel back when asked to and the save fails", async () => {
    hydratePreferences({ updateChannel: "stable" });
    saveMock.mockRejectedValue(new Error("SHELL_STATE_WRITE_FAILED"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { result } = renderHook(() => usePreference("updateChannel"));

    await act(async () => {
      await setPreference("updateChannel", "beta");
    });

    expect(result.current).toBe("stable");
    consoleError.mockRestore();
  });

  // Rust reads each of these off disk; a failed save must not leave Settings saying one thing
  // while the app does another (a zoomed frame over an unzoomed page, "Quit" that hides).
  it.each([
    ["uiZoom", 100, 125],
    ["closeAction", "tray", "quit"],
    ["notifications", "on", "off"],
    ["launchLights", "resume", "off"],
  ] as const)("puts %s back when the save fails", async (key, before, after) => {
    hydratePreferences({ [key]: before });
    saveMock.mockRejectedValue(new Error("SHELL_STATE_WRITE_FAILED"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { result } = renderHook(() => usePreference(key));

    await act(async () => {
      await setPreference(key, after as never);
    });

    expect(result.current).toBe(before);
    consoleError.mockRestore();
  });
});
