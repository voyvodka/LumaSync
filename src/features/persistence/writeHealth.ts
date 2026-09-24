/**
 * Whether this window's last shell-state write failed. A setting that could
 * not be saved used to fail in a console line only: a toggle snapped back or,
 * for the language, looked saved and reverted on the next launch. The shell
 * turns this latch into one notice; the next write that lands clears it.
 */

import { createStore, useStoreSelector } from "@/shared/lib/store";

const store = createStore(false);

const selectFailing = (failing: boolean) => failing;

export function reportShellStateWrite(ok: boolean): void {
  store.set(!ok);
}

export function isShellStateWriteFailing(): boolean {
  return store.get();
}

export function useShellStateWriteFailing(): boolean {
  return useStoreSelector(store, selectFailing);
}

/** Test-only: back to a healthy latch. */
export function __resetShellStateWriteHealthForTests(): void {
  store.set(false);
}
