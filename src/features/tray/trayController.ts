/**
 * Tray Controller
 *
 * Frontend bridge for tray menu actions that require frontend coordination:
 * - Startup Toggle: syncs autostart state with tray check item via plugin-autostart
 * - Open Settings: triggered by Rust via "tray:open-settings" event (fallback path)
 *
 * Tray menu ID constants are imported from shell contracts — never hardcode strings here.
 */

import { enable, disable, isEnabled } from "@tauri-apps/plugin-autostart";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { TRAY_MENU_IDS, SHELL_COMMANDS } from "../../shared/contracts/shell";

export async function setStartupTrayChecked(checked: boolean): Promise<void> {
  await invoke(SHELL_COMMANDS.SET_TRAY_STARTUP_CHECKED, { checked });
}

// ---------------------------------------------------------------------------
// Startup toggle
// ---------------------------------------------------------------------------

/** Toggle run-at-login and return the new state */
export async function toggleStartup(): Promise<boolean> {
  const enabled = await isEnabled();
  if (enabled) {
    await disable();
    await setStartupTrayChecked(false);
    return false;
  } else {
    await enable();
    await setStartupTrayChecked(true);
    return true;
  }
}

/** Read current autostart state */
export async function getStartupEnabled(): Promise<boolean> {
  return isEnabled();
}

// ---------------------------------------------------------------------------
// Event listeners
// ---------------------------------------------------------------------------

/**
 * Listen for the startup-state-changed event emitted from Rust after it has
 * already toggled autostart state. The payload is the new boolean state.
 * The frontend does NOT toggle autostart here — Rust is authoritative.
 */
export async function listenStartupToggle(
  onToggle: (newState: boolean) => void
): Promise<UnlistenFn> {
  return listen<boolean>("tray:startup-state-changed", (event) => {
    onToggle(event.payload);
  });
}

// ---------------------------------------------------------------------------
// Re-export tray menu IDs for consumer convenience
// ---------------------------------------------------------------------------
export { TRAY_MENU_IDS };
