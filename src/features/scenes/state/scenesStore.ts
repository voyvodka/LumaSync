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
/** This window's own edits still being written; their echoes would show an older list meanwhile. */
let pending = 0;
/** The list as last known to be stored, which a failed edit falls back to. */
let lastStored: StoredScene[] | null = null;

const hasScenes = (state: Partial<ShellState>) => Object.prototype.hasOwnProperty.call(state, "scenes");

/** Starts following the stored scenes. `loaded` is a state this window already read at boot. */
export function hydrateScenes(loaded?: Partial<ShellState>): void {
  if (hydrated) return;
  hydrated = true;
  // A removed key arrives as its own `undefined`: back to the seeded list.
  stopFollowingSaves = shellStore.onSaved((saved) => {
    if (!hasScenes(saved)) return;
    lastStored = readStoredScenes(saved.scenes);
    if (pending === 0) store.set(lastStored);
  });
  const apply = (state: Partial<ShellState>) => {
    lastStored ??= readStoredScenes(state.scenes);
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
 * puts the stored list back, since a scene that was never saved would be gone next launch. `edit`
 * runs on both lists (and again on a retry), so it must not mint ids itself. While edits overlap,
 * the list shown is the newest edit's; the stored one is shown once the last of them lands.
 */
export async function editScenes(edit: (scenes: readonly StoredScene[]) => StoredScene[] | null): Promise<void> {
  const previous = store.get();
  const shown = edit(previous);
  if (!shown) return;
  editedBeforeLoad = true;
  store.set(shown);
  pending += 1;
  try {
    const stored = await shellStore.update((state) => {
      // A shape a newer build wrote is left alone: this build would overwrite it with its own.
      if (state.scenes !== undefined && !Array.isArray(state.scenes)) throw new Error(SCENES_UNREADABLE);
      const next = edit(readStoredScenes(state.scenes));
      return next ? { scenes: next } : null;
    });
    lastStored = readStoredScenes(stored.scenes);
    // What was written, where another write made it differ from what was shown.
    if (--pending === 0) store.set(lastStored);
  } catch (error) {
    console.error("[LumaSync] saving the scenes failed:", error);
    if (--pending === 0) store.set(lastStored ?? previous);
    throw error;
  }
}

/** Test-only: back to the cold seeded list. */
export function __resetScenesForTests(scenes?: StoredScene[]): void {
  stopFollowingSaves?.();
  stopFollowingSaves = null;
  hydrated = scenes !== undefined;
  editedBeforeLoad = false;
  pending = 0;
  lastStored = scenes ?? null;
  store.set(scenes ?? readStoredScenes(undefined));
}
