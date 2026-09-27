import { useEffect } from "react";

import type { LocalOutputsSnapshot } from "@/shared/contracts/device";
import { createStore, useStoreSelector, type Store } from "@/shared/lib/store";

import { listenLocalOutputsChanged, type UnlistenFn } from "../deviceEventsApi";
import { getLocalOutputs } from "../localOutputsApi";

export interface LocalOutputsState {
  /** `null` until the first answer: before it, nothing is known to be connected. */
  snapshot: LocalOutputsSnapshot | null;
}

export interface LocalOutputsDeps {
  read: () => Promise<LocalOutputsSnapshot>;
  listen: (handler: (snapshot: LocalOutputsSnapshot) => void) => Promise<UnlistenFn>;
}

export interface LocalOutputs {
  store: Store<LocalOutputsState>;
  /** Takes `snapshot` when it is newer than what is held; `false` when it was dropped. */
  ingest: (snapshot: LocalOutputsSnapshot) => boolean;
  /** Reads the registry again. After a command that changed it, so a reader never guesses. */
  refresh: () => Promise<LocalOutputsSnapshot | null>;
  /** Starts following the registry; the returned function stops it. Counted, so several holders share one listener. */
  start: () => () => void;
}

/**
 * Rust's local-output registry as the main window holds it. Events are sent outside the
 * registry's lock and can arrive out of order, so a snapshot that is not newer than the one held is
 * dropped. The listener is registered before the first read: a change landing between the two is
 * then either in the read or in an event after it, never lost.
 */
export function createLocalOutputs(deps: LocalOutputsDeps): LocalOutputs {
  const store = createStore<LocalOutputsState>({ snapshot: null });
  let holders = 0;
  let unlisten: Promise<UnlistenFn | null> | null = null;

  const ingest = (snapshot: LocalOutputsSnapshot): boolean => {
    const held = store.get().snapshot;
    if (held !== null && snapshot.revision <= held.revision) return false;
    store.set({ snapshot });
    return true;
  };

  const refresh = async (): Promise<LocalOutputsSnapshot | null> => {
    try {
      const snapshot = await deps.read();
      ingest(snapshot);
      return store.get().snapshot;
    } catch (error) {
      console.error("[LumaSync] reading the local outputs failed:", error);
      return store.get().snapshot;
    }
  };

  const start = () => {
    holders += 1;
    if (holders === 1) {
      unlisten = deps
        .listen((snapshot) => {
          ingest(snapshot);
        })
        .catch((error: unknown) => {
          console.error("[LumaSync] listening for local-output changes failed:", error);
          return null;
        });
      void unlisten.then(() => refresh());
    }
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      holders -= 1;
      if (holders === 0 && unlisten !== null) {
        const pending = unlisten;
        unlisten = null;
        void pending.then((stop) => stop?.());
      }
    };
  };

  return { store, ingest, refresh, start };
}

export const localOutputs = createLocalOutputs({ read: getLocalOutputs, listen: listenLocalOutputsChanged });

/** A slice of the registry; mounting it keeps the store following Rust. */
export function useLocalOutputs<S>(
  selector: (state: LocalOutputsState) => S,
  isEqual?: (a: S, b: S) => boolean,
): S {
  useEffect(() => localOutputs.start(), []);
  return useStoreSelector(localOutputs.store, selector, isEqual);
}
