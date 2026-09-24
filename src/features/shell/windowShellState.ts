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
import { reportShellStateWrite } from "../persistence/writeHealth";
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

/** A stored snapshot as the app reads it: defaults filled in, then migrated. */
function readSnapshot(saved: Partial<ShellState>): ShellState {
  // `schemaVersion` defaults to `1`, NOT the latest — an absent version is a
  // legacy snapshot the shim below still has to upgrade.
  const merged: ShellState = {
    ...DEFAULT_SHELL_STATE,
    ...saved,
    schemaVersion: saved.schemaVersion ?? 1,
  };

  // Caught so one corrupt persisted record cannot brick startup: we fall back
  // to the unmigrated shape and the next launch retries.
  try {
    return migrateShellState(merged);
  } catch (error) {
    console.warn(
      "[LumaSync] migration: schemaVersion upgrade failed; keeping legacy shape until next launch",
      error,
    );
    return merged;
  }
}

export async function loadShellState(): Promise<ShellState> {
  for (let attempt = 1; ; attempt++) {
    const { state: saved, revision } = await getShellState();
    if (!saved) return { ...DEFAULT_SHELL_STATE };

    const migrated = readSnapshot(saved);

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
    try {
      await patchShellState(toShellStatePatch(state, WRITER_ID));
    } catch (error) {
      reportShellStateWrite(false);
      throw error;
    }
    reportShellStateWrite(true);
    notifyShellStateSaved(state);
  });

  // The queue continues past a rejection; the caller still sees it via `write`.
  // Without this a single failed write would wedge every later one forever.
  shellWriteQueue = write.catch(() => {});

  return write;
}

/** A conflict means another write landed between the read and the swap. */
const UPDATE_WRITE_ATTEMPTS = 5;

/**
 * Read-modify-write of keys whose value is derived from what is stored — a
 * nested object such as `roomMap`, where a patch of the whole key would revert
 * a field another writer (another window, or Rust) changed in between. `update`
 * returns the partial to apply, or `null` to write nothing; it is re-run on a
 * fresh read after a conflict, so it must be pure. Resolves with the state the
 * update was applied to, as written. Main window only: the twin overlay has no
 * grant for `replace_shell_state`.
 */
export async function updateShellState(
  update: (current: ShellState) => Partial<ShellState> | null,
): Promise<ShellState> {
  const write = shellWriteQueue.then(async () => {
    for (let attempt = 1; ; attempt++) {
      const { state: saved, revision } = await getShellState();
      const current = saved ? readSnapshot(saved) : { ...DEFAULT_SHELL_STATE };
      const partial = update(current);
      if (!partial) return current;

      const next: ShellState = { ...current, ...partial };
      let result: Awaited<ReturnType<typeof replaceShellState>>;
      try {
        result = await replaceShellState({ state: next, expectedRevision: revision, writerId: WRITER_ID });
      } catch (error) {
        reportShellStateWrite(false);
        throw error;
      }
      if (result.applied) {
        reportShellStateWrite(true);
        notifyShellStateSaved(partial);
        return next;
      }
      if (attempt >= UPDATE_WRITE_ATTEMPTS) {
        throw new Error(`shell-state update lost ${attempt} races to other writes`);
      }
    }
  });

  shellWriteQueue = write.then(
    () => undefined,
    () => undefined,
  );

  return write;
}
