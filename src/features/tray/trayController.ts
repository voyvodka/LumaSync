/**
 * Tray Controller
 *
 * Frontend bridge for tray menu actions:
 * - Quick actions: lights off, resume last mode, solid color
 * - Label i18n: push translated strings to Rust via update_tray_labels
 * - Startup toggle: managed via plugin-autostart (no tray checkbox)
 *
 * Tray menu ID constants are imported from shell contracts — never hardcode strings here.
 */

import { enable, disable, isEnabled } from "@tauri-apps/plugin-autostart";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { TRAY_MENU_IDS, SHELL_COMMANDS } from "../../shared/contracts/shell";

// ---------------------------------------------------------------------------
// Tray label i18n
// ---------------------------------------------------------------------------

export interface TrayLabels {
  openSettings: string;
  lightsOff: string;
  resumeLastMode: string;
  solidColor: string;
  quit: string;
}

export async function updateTrayLabels(labels: TrayLabels): Promise<void> {
  await invoke(SHELL_COMMANDS.UPDATE_TRAY_LABELS, { labels });
}

// ---------------------------------------------------------------------------
// Startup toggle (no tray checkbox — managed in System settings only)
// ---------------------------------------------------------------------------

/**
 * Toggle run-at-login and return the new state.
 * The tray menu no longer has a checkbox for this; autostart state is
 * controlled exclusively from the System settings section.
 */
export async function toggleStartup(): Promise<boolean> {
  const enabled = await isEnabled();
  if (enabled) {
    await disable();
    return false;
  } else {
    await enable();
    return true;
  }
}

/** Read current autostart state */
export async function getStartupEnabled(): Promise<boolean> {
  return isEnabled();
}

/**
 * No-op — kept for API compatibility. The tray startup checkbox was removed;
 * nothing needs to be synced in the Rust menu.
 */
export async function setStartupTrayChecked(_checked: boolean): Promise<void> {}

// ---------------------------------------------------------------------------
// Tray quick action event listeners
// ---------------------------------------------------------------------------

export async function listenTrayLightsOff(
  onTrigger: () => void
): Promise<UnlistenFn> {
  return listen("tray:lights-off", () => onTrigger());
}

export async function listenTrayResumeLastMode(
  onTrigger: () => void
): Promise<UnlistenFn> {
  return listen("tray:resume-last-mode", () => onTrigger());
}

export async function listenTraySolidColor(
  onTrigger: () => void
): Promise<UnlistenFn> {
  return listen("tray:solid-color", () => onTrigger());
}

/**
 * Listen for startup state changes emitted from Rust (legacy: was triggered
 * by tray checkbox click). Now emitted only on external autostart changes.
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
