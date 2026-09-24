/**
 * Shell Store
 *
 * Persistence layer for shell state.
 *
 * This module provides the public API for reading and writing persisted shell
 * state (window geometry, last visited section, startup preference, and the
 * one-time tray hint flag). It delegates to `windowLifecycle`, which holds this
 * window's write queue and reaches the Rust-owned file through `shellStateApi`.
 *
 * Usage:
 *   import { shellStore } from './shellStore';
 *   const state = await shellStore.load();
 *   await shellStore.save({ lastSection: 'startup-tray' });
 */

import {
  loadShellState,
  onShellStateSaved,
  saveShellState,
  updateShellState,
  type ShellStateSavedListener,
} from "../shell/windowLifecycle";
import type { ShellState } from "@/shared/contracts/shell";
import { DEFAULT_SHELL_STATE } from "@/shared/contracts/shell";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const shellStore = {
  /**
   * Load the full persisted shell state.
   * Returns merged defaults so callers always get a complete ShellState.
   */
  async load(): Promise<ShellState> {
    return loadShellState();
  },

  /**
   * Persist a partial update to shell state.
   * Merges with existing state so callers only specify changed fields.
   */
  async save(partial: Partial<ShellState>): Promise<void> {
    return saveShellState(partial);
  },

  /**
   * Derive a partial from the stored state and write it only if nothing else
   * was written meanwhile, retrying on a fresh read — see {@link updateShellState}.
   * For a nested key such as `roomMap`, where `save` would revert a field
   * another writer changed between the read and the save.
   */
  async update(update: (current: ShellState) => Partial<ShellState> | null): Promise<ShellState> {
    return updateShellState(update);
  },

  /** Fires after every successful save, in any window — see {@link onShellStateSaved}. */
  onSaved(listener: ShellStateSavedListener): () => void {
    return onShellStateSaved(listener);
  },

  /**
   * Reset shell state to defaults (useful for testing or factory reset).
   */
  async reset(): Promise<void> {
    return saveShellState(DEFAULT_SHELL_STATE);
  },
};

// ---------------------------------------------------------------------------
// Named re-exports for direct import convenience
// ---------------------------------------------------------------------------

export { loadShellState, onShellStateSaved, saveShellState, updateShellState };
export type { ShellStateSavedListener };
export type { ShellState };
export { DEFAULT_SHELL_STATE };
