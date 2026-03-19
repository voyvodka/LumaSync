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
import { TRAY_MENU_IDS } from "../../shared/contracts/shell";

const SET_TRAY_STARTUP_CHECKED_COMMAND = "set_tray_startup_checked";

export async function setStartupTrayChecked(checked: boolean): Promise<void> {
  await invoke(SET_TRAY_STARTUP_CHECKED_COMMAND, { checked });
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
 * Listen for the startup-toggle click event emitted from Rust when the tray
 * menu item is clicked. Toggles autostart state and invokes optional callback
 * so UI can sync state.
 */
export async function listenStartupToggle(
  onToggle: (newState: boolean) => void
): Promise<UnlistenFn> {
  return listen("tray:startup-toggle-clicked", async () => {
    const newState = await toggleStartup();
    onToggle(newState);
  });
}

// ---------------------------------------------------------------------------
// Re-export tray menu IDs for consumer convenience
// ---------------------------------------------------------------------------
export { TRAY_MENU_IDS };
