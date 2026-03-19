/**
 * Shell Store
 *
 * Persistence layer for shell state.
 *
 * This module provides the public API for reading and writing persisted shell
 * state (window geometry, last visited section, startup preference, and the
 * one-time tray hint flag). It delegates to `windowLifecycle` for the actual
 * Tauri plugin-store calls so there is a single store instance.
 *
 * Usage:
 *   import { shellStore } from './shellStore';
 *   const state = await shellStore.load();
 *   await shellStore.save({ lastSection: 'startup-tray' });
 */

import { loadShellState, saveShellState } from "../shell/windowLifecycle";
import type { ShellState } from "../../shared/contracts/shell";
import { DEFAULT_SHELL_STATE } from "../../shared/contracts/shell";

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
   * Reset shell state to defaults (useful for testing or factory reset).
   */
  async reset(): Promise<void> {
    return saveShellState(DEFAULT_SHELL_STATE);
  },
};

// ---------------------------------------------------------------------------
// Named re-exports for direct import convenience
// ---------------------------------------------------------------------------

export { loadShellState, saveShellState };
export type { ShellState };
export { DEFAULT_SHELL_STATE };
