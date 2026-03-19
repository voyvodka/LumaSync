/**
 * Window Lifecycle
 *
 * Handles close-to-tray interception and one-time tray hint logic.
 * Uses plugin-store for persisting the `trayHintShown` flag.
 *
 * Usage: call `initWindowLifecycle()` once during app bootstrap.
 */

import { getCurrentWindow, availableMonitors, PhysicalSize, PhysicalPosition } from "@tauri-apps/api/window";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { load } from "@tauri-apps/plugin-store";
import {
  SHELL_STORE_KEY,
  DEFAULT_SHELL_STATE,
  type ShellState,
} from "../../shared/contracts/shell";

// ---------------------------------------------------------------------------
// Store helpers
// ---------------------------------------------------------------------------

async function getStore() {
  // Opens (or creates) the shell state store at the default app data directory.
  // `defaults` is required by the StoreOptions type — provide shell defaults.
  return load(`${SHELL_STORE_KEY}.json`, {
    defaults: { [SHELL_STORE_KEY]: DEFAULT_SHELL_STATE },
    autoSave: true,
  });
}

export async function loadShellState(): Promise<ShellState> {
  const store = await getStore();
  const saved = await store.get<ShellState>(SHELL_STORE_KEY);
  if (!saved) return { ...DEFAULT_SHELL_STATE };

  // Merge with defaults to handle new fields added in future phases
  return { ...DEFAULT_SHELL_STATE, ...saved };
}

export async function saveShellState(state: Partial<ShellState>): Promise<void> {
  const store = await getStore();
  const current = await loadShellState();
  await store.set(SHELL_STORE_KEY, { ...current, ...state });
}

// ---------------------------------------------------------------------------
// Close-to-tray one-time hint
// ---------------------------------------------------------------------------

/** Callback type for the tray hint display */
export type TrayHintCallback = () => void;

let unlistenCloseToTray: UnlistenFn | null = null;

/**
 * Register the shell:close-to-tray event listener that shows a one-time
 * educational hint the first time the user closes the settings window.
 *
 * @param onFirstClose Called the first time the user closes to tray (hint shown).
 *                     Not called on subsequent closes.
 */
export async function initCloseToTrayHint(
  onFirstClose?: TrayHintCallback
): Promise<void> {
  // Clean up any previous listener
  if (unlistenCloseToTray) {
    unlistenCloseToTray();
    unlistenCloseToTray = null;
  }

  unlistenCloseToTray = await listen("shell:close-to-tray", async () => {
    const state = await loadShellState();
    if (!state.trayHintShown) {
      await saveShellState({ trayHintShown: true });
      onFirstClose?.();
    }
  });
}

// ---------------------------------------------------------------------------
// Monitor bounds guard
// ---------------------------------------------------------------------------

/**
 * Validate window position against available monitors.
 * Returns `true` if the position is within any monitor's visible area;
 * `false` if it is off-screen and should be reset.
 */
async function isPositionOnScreen(x: number, y: number): Promise<boolean> {
  const monitors = await availableMonitors();
  for (const monitor of monitors) {
    const { x: mx, y: my } = monitor.position;
    const { width: mw, height: mh } = monitor.size;
    // A 20px margin to account for panels/taskbars near edges
    if (x >= mx - 20 && y >= my - 20 && x < mx + mw && y < my + mh) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Window position restoration
// ---------------------------------------------------------------------------

/**
 * Restore window position and size from persisted shell state.
 * Falls back to safe centered position if saved coords are off-screen.
 */
export async function restoreWindowState(): Promise<void> {
  const win = getCurrentWindow();
  const state = await loadShellState();

  // Restore size
  if (state.windowWidth && state.windowHeight) {
    await win.setSize(new PhysicalSize(state.windowWidth, state.windowHeight));
  }

  // Restore position (with monitor-bounds guard)
  if (state.windowX !== null && state.windowY !== null) {
    const onScreen = await isPositionOnScreen(state.windowX, state.windowY);
    if (onScreen) {
      await win.setPosition(new PhysicalPosition(state.windowX, state.windowY));
    } else {
      // Off-screen: reset to centered
      await win.center();
    }
  }
}

/**
 * Persist current window geometry to shell state store.
 * Call this before hiding or on a debounced resize/move handler.
 */
export async function persistWindowState(): Promise<void> {
  const win = getCurrentWindow();
  const { width, height } = await win.innerSize();
  const { x, y } = await win.outerPosition();
  await saveShellState({ windowWidth: width, windowHeight: height, windowX: x, windowY: y });
}

// ---------------------------------------------------------------------------
// Full lifecycle init
// ---------------------------------------------------------------------------

/**
 * Initialize the full window lifecycle:
 * - Restore window state
 * - Register close-to-tray hint listener
 *
 * Call once during app bootstrap after i18n is ready so hints can be translated.
 */
export async function initWindowLifecycle(opts?: {
  onFirstClosToTray?: TrayHintCallback;
}): Promise<void> {
  await restoreWindowState();
  await initCloseToTrayHint(opts?.onFirstClosToTray);
}
