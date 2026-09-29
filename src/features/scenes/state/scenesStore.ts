/**
 * The user's scenes, read with the boot read so the row opens on them, then kept in step with every
 * save. Written from the main window only, through `shellStore.update`, so an edit replays on the
 * list as stored rather than on a copy that may be behind.
 */

import { shellStore } from "@/features/persistence/shellStore";
import type { ShellState } from "@/shared/contracts/shell";
import type { StoredScene } from "@/shared/contracts/scenes";
import { createStore, useStoreSelector } from "@/shared/lib/store";

import { readStoredScenes } from "../model/sceneLibrary";

const SCENES_UNREADABLE = "SCENES_UNREADABLE";

const store = createStore<StoredScene[]>(readStoredScenes(undefined));
let hydrated = false;
/** An edit made before the boot read landed wins over it. */
let editedBeforeLoad = false;
let stopFollowingSaves: (() => void) | null = null;

const hasScenes = (state: Partial<ShellState>) => Object.prototype.hasOwnProperty.call(state, "scenes");

/** Starts following the stored scenes. `loaded` is a state this window already read at boot. */
export function hydrateScenes(loaded?: Partial<ShellState>): void {
  if (hydrated) return;
  hydrated = true;
  // A removed key arrives as its own `undefined`: back to the seeded list.
  stopFollowingSaves = shellStore.onSaved((saved) => {
    if (hasScenes(saved)) store.set(readStoredScenes(saved.scenes));
  });
  const apply = (state: Partial<ShellState>) => {
    if (!editedBeforeLoad) store.set(readStoredScenes(state.scenes));
  };
  if (loaded) {
    apply(loaded);
    return;
  }
  shellStore
    .load()
    .then(apply)
    .catch((error: unknown) => {
      console.error("[LumaSync] loading the scenes failed:", error);
    });
}

export function useScenes(): StoredScene[] {
  if (!hydrated) hydrateScenes();
  return useStoreSelector(store, (scenes) => scenes);
}

export function getScenes(): StoredScene[] {
  return store.get();
}

/**
 * Shown at once, then written on the stored list; `null` from `edit` writes nothing. A failed write
 * puts the list back, since a scene that was never saved would be gone next launch. `edit` runs on
 * both lists (and again on a retry), so it must not mint ids itself.
 */
export async function editScenes(edit: (scenes: readonly StoredScene[]) => StoredScene[] | null): Promise<void> {
  const previous = store.get();
  const shown = edit(previous);
  if (!shown) return;
  editedBeforeLoad = true;
  store.set(shown);
  try {
    const stored = await shellStore.update((state) => {
      // A shape a newer build wrote is left alone: this build would overwrite it with its own.
      if (state.scenes !== undefined && !Array.isArray(state.scenes)) throw new Error(SCENES_UNREADABLE);
      const next = edit(readStoredScenes(state.scenes));
      return next ? { scenes: next } : null;
    });
    // What was written, where another write made it differ from what was shown.
    store.set(readStoredScenes(stored.scenes));
  } catch (error) {
    console.error("[LumaSync] saving the scenes failed:", error);
    store.set(previous);
    throw error;
  }
}

/** Test-only: back to the cold seeded list. */
export function __resetScenesForTests(scenes?: StoredScene[]): void {
  stopFollowingSaves?.();
  stopFollowingSaves = null;
  hydrated = scenes !== undefined;
  editedBeforeLoad = false;
  store.set(scenes ?? readStoredScenes(undefined));
}
