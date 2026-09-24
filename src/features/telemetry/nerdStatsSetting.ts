/**
 * Settings → General "Show stats for nerds" (`ShellState.showNerdStats`).
 * Off — the default, absent included — mounts nothing that polls
 * `get_runtime_telemetry`: the FPS and CAP pills and the telemetry readout
 * only exist while it is on. Read by the status bar and the General section,
 * so it lives in one store that both follow live, no restart.
 */

import { useEffect } from "react";

import { shellStore } from "@/features/persistence/shellStore";
import { createStore, useStoreSelector } from "@/shared/lib/store";

const store = createStore(false);

let hydrated = false;
/** A choice made before the persisted value arrived wins over it. */
let chosenBeforeLoad = false;
let stopFollowingSaves: (() => void) | null = null;

const selectValue = (value: boolean) => value;

function hydrate(): void {
  if (hydrated) return;
  hydrated = true;

  // Another window's write, or this one's own echo.
  stopFollowingSaves = shellStore.onSaved((saved) => {
    if (Object.prototype.hasOwnProperty.call(saved, "showNerdStats")) {
      store.set(saved.showNerdStats === true);
    }
  });

  shellStore
    .load()
    .then((state) => {
      if (!chosenBeforeLoad) store.set(state.showNerdStats === true);
    })
    .catch((err: unknown) => {
      console.error("[LumaSync] loading showNerdStats failed:", err);
    });
}

export function useShowNerdStats(): boolean {
  useEffect(() => {
    hydrate();
  }, []);
  return useStoreSelector(store, selectValue);
}

/**
 * Applies at once and holds for the session even when the save fails: it is a
 * view preference nothing reads from disk, and the shell's "settings can't be
 * saved" notice says a change lasts until quit — a switch that snapped back
 * would contradict it.
 */
export async function setShowNerdStats(next: boolean): Promise<void> {
  chosenBeforeLoad = true;
  store.set(next);
  try {
    await shellStore.save({ showNerdStats: next });
  } catch (err) {
    console.error("[LumaSync] shellStore.save(showNerdStats) failed:", err);
  }
}

/** Test-only: seed the value without touching the persisted state. */
export function __setShowNerdStatsForTests(value: boolean): void {
  hydrated = true;
  chosenBeforeLoad = true;
  store.set(value);
}

/** Test-only: back to a cold, unhydrated off. */
export function __resetShowNerdStatsForTests(): void {
  stopFollowingSaves?.();
  stopFollowingSaves = null;
  hydrated = false;
  chosenBeforeLoad = false;
  store.set(false);
}
