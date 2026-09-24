/**
 * This window's side of the shell-state facade: reads, the write queue and the
 * saved listeners. Rust owns the file — see docs/architecture/contracts-and-state.md,
 * "Shell-state ownership".
 */

import {
  DEFAULT_SHELL_STATE,
  type ShellState,
  type ShellStateChanged,
} from "@/shared/contracts/shell";
import { migrateShellState } from "../persistence/migrations";
import {
  getShellState,
  onShellStateChanged,
  patchShellState,
  replaceShellState,
  toShellStatePatch,
} from "../persistence/shellStateApi";

/** Tags this window's writes, so it can drop the echo of its own change events. */
const WRITER_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/** A conflict means another window wrote in between; its state is re-read and
 * re-migrated, which normally settles on the second try. */
const MIGRATION_WRITE_ATTEMPTS = 3;

export async function loadShellState(): Promise<ShellState> {
  for (let attempt = 1; ; attempt++) {
    const { state: saved, revision } = await getShellState();
    if (!saved) return { ...DEFAULT_SHELL_STATE };

    // `schemaVersion` defaults to `1`, NOT the latest — an absent version is a
    // legacy snapshot the shim below still has to upgrade.
    const merged: ShellState = {
      ...DEFAULT_SHELL_STATE,
      ...saved,
      schemaVersion: saved.schemaVersion ?? 1,
    };

    // Caught so one corrupt persisted record cannot brick startup: we fall back
    // to the unmigrated shape and the next launch retries.
    let migrated: ShellState;
    try {
      migrated = migrateShellState(merged);
    } catch (error) {
      console.warn(
        "[LumaSync] migration: schemaVersion upgrade failed; keeping legacy shape until next launch",
        error,
      );
      migrated = merged;
    }

    if (saved.schemaVersion !== undefined && migrated.schemaVersion === saved.schemaVersion) {
      return migrated;
    }

    // Persist the migrated shape back so subsequent reads skip this branch —
    // but only over the state it was derived from, never over a newer write.
    try {
      const result = await replaceShellState({
        state: migrated,
        expectedRevision: revision,
        writerId: WRITER_ID,
      });
      if (result.applied) return migrated;
    } catch (error) {
      // Not fatal: the twin has no grant for the write-back, and the migrated
      // shape is correct in memory either way. The next load retries.
      console.warn(
        "[LumaSync] migration: write-back failed; using the migrated shape unsaved",
        error,
      );
      return migrated;
    }

    if (attempt >= MIGRATION_WRITE_ATTEMPTS) {
      console.warn(
        `[LumaSync] migration: write-back lost ${attempt} races to other writes; using the migrated shape unsaved`,
      );
      return migrated;
    }
  }
}

/** Tail of the serialised write chain — see {@link saveShellState}. */
let shellWriteQueue: Promise<void> = Promise.resolve();

export type ShellStateSavedListener = (saved: Partial<ShellState>) => void;

const shellStateSavedListeners = new Set<ShellStateSavedListener>();

/** Settles once this window listens for other windows' writes. */
let changeSubscription: Promise<void> | null = null;

function subscribeToOtherWindowsWrites(): void {
  if (changeSubscription !== null) return;
  changeSubscription = onShellStateChanged((changed) => {
    // This window's own writes were delivered when they resolved.
    if (changed.writerId === WRITER_ID) return;
    notifyShellStateSaved(toSavedPartial(changed));
  }).then(
    () => undefined,
    (error: unknown) => {
      console.error(
        "[LumaSync] shell-state change subscription failed; other windows' saves will not reach this window's listeners:",
        error,
      );
    },
  );
}

/** The partial a listener would have been handed in the writing window: a
 * removed key reads as `undefined`, which is how it was written. */
function toSavedPartial(changed: ShellStateChanged): Partial<ShellState> {
  const saved: Record<string, unknown> = { ...changed.set };
  for (const key of changed.remove) saved[key] = undefined;
  return saved as Partial<ShellState>;
}

/** Called with each partial once it is on disk: this window's writes as soon as
 * they resolve, every other window's through the change event. Returns the
 * unsubscribe. */
export function onShellStateSaved(listener: ShellStateSavedListener): () => void {
  subscribeToOtherWindowsWrites();
  shellStateSavedListeners.add(listener);
  return () => {
    shellStateSavedListeners.delete(listener);
  };
}

function notifyShellStateSaved(saved: Partial<ShellState>): void {
  for (const listener of shellStateSavedListeners) {
    try {
      listener(saved);
    } catch (error) {
      // A listener's fault must not read as a failed write to the caller.
      console.error("[LumaSync] shell-state saved listener failed:", error);
    }
  }
}

/** Persist a partial update. Rust merges it under its one lock, so writers in
 * different windows cannot revert each other; the queue only keeps this
 * window's writes in the order they were issued, since two invokes in flight
 * are not ordered with each other. An `undefined` value deletes the key. */
export async function saveShellState(state: Partial<ShellState>): Promise<void> {
  const write = shellWriteQueue.then(async () => {
    await patchShellState(toShellStatePatch(state, WRITER_ID));
    notifyShellStateSaved(state);
  });

  // The queue continues past a rejection; the caller still sees it via `write`.
  // Without this a single failed write would wedge every later one forever.
  shellWriteQueue = write.catch(() => {});

  return write;
}
