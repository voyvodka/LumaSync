import { afterEach, describe, expect, it, vi } from "vitest";

import type { StoredScene } from "@/shared/contracts/scenes";
import type { ShellState } from "@/shared/contracts/shell";

import { withSceneName } from "../../model/sceneLibrary";
import { __resetScenesForTests, editScenes, getScenes, hydrateScenes } from "../scenesStore";

const listeners: ((saved: Partial<ShellState>) => void)[] = [];
const load = vi.fn<() => Promise<Partial<ShellState>>>(() => Promise.resolve({}));
const disk: { state: Partial<ShellState> } = { state: {} };

vi.mock("@/features/persistence/shellStore", () => ({
  shellStore: {
    load: () => load(),
    update: async (fn: (s: Partial<ShellState>) => Partial<ShellState> | null) => {
      const patch = fn(structuredClone(disk.state));
      if (patch) disk.state = { ...disk.state, ...patch };
      return disk.state;
    },
    onSaved: (listener: (saved: Partial<ShellState>) => void) => {
      listeners.push(listener);
      return () => listeners.splice(listeners.indexOf(listener), 1);
    },
  },
}));

const blue: StoredScene = { id: "b", kind: "solid", solid: { r: 0, g: 0, b: 255, brightness: 1 } };

afterEach(() => {
  disk.state = {};
  __resetScenesForTests();
  listeners.length = 0;
  load.mockClear();
});

describe("scenesStore", () => {
  it("opens on the boot read without reading again", () => {
    __resetScenesForTests();
    // Reset leaves it cold; the boot read hydrates it.
    hydrateScenes({ scenes: [blue] });
    expect(getScenes()).toEqual([blue]);
    expect(load).not.toHaveBeenCalled();
  });

  it("follows a save from any window, and a removed key reads as the seeded list", () => {
    hydrateScenes({ scenes: [] });
    listeners.forEach((l) => l({ scenes: [blue] }));
    expect(getScenes()).toEqual([blue]);
    listeners.forEach((l) => l({ language: "tr" }));
    expect(getScenes()).toEqual([blue]);
    listeners.forEach((l) => l({ scenes: undefined }));
    expect(getScenes().map((s) => s.id)).toContain("seed-movie");
  });

  it("keeps an edit made before the boot read landed", async () => {
    let resolve!: (state: Partial<ShellState>) => void;
    load.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    hydrateScenes();
    await editScenes(() => [blue]);
    resolve({ scenes: [] });
    await Promise.resolve();
    expect(getScenes()).toEqual([blue]);
  });

  it("writes an entry it cannot play back exactly as it was, when a neighbour changes", async () => {
    const future = { id: "f", kind: "music", music: { band: 3, sync: "beat" }, extra: [1, 2] } as unknown as StoredScene;
    disk.state = { scenes: [future, blue] };
    hydrateScenes(disk.state);
    await editScenes((list) => withSceneName(list, "b", "Mine"));
    expect(disk.state.scenes?.[0]).toEqual(future);
    expect(disk.state.scenes?.[1]).toMatchObject({ id: "b", name: "Mine" });
  });

  it("leaves a list shape it cannot read alone, and says the edit did not land", async () => {
    const newer = { version: 2, items: [] } as unknown as StoredScene[];
    disk.state = { scenes: newer };
    hydrateScenes(disk.state);
    await expect(editScenes((list) => [...list, blue])).rejects.toThrow("SCENES_UNREADABLE");
    expect(disk.state.scenes).toBe(newer);
    expect(getScenes().map((s) => s.id)).not.toContain("b");
  });
});
