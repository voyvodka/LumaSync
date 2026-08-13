import { useSyncExternalStore } from "react";

// The two bounded Hue poll loops sit in different trees (App root and the
// Devices section) and the retry control that re-arms them sits in a third, so
// the signal travels through a module store rather than props.
let token = 0;
const listeners = new Set<() => void>();

/** Re-arm every Hue poll loop that has given up. Safe to call when none has. */
export function requestHuePollRestart(): void {
  token += 1;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getToken(): number {
  return token;
}

/** Changes on every {@link requestHuePollRestart}; belongs in a poll effect's deps. */
export function useHuePollRestartToken(): number {
  return useSyncExternalStore(subscribe, getToken, getToken);
}
