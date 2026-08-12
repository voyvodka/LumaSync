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
import { TRAY_MENU_IDS } from "@/shared/contracts/shell";

// Tray label i18n moved to trayApi.ts; re-exported to avoid consumer churn.
export { type TrayLabels, updateTrayLabels } from "./trayApi";

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

/** Listen for the tray "Lights off" quick action. */
export async function listenTrayLightsOff(
  onTrigger: () => void
): Promise<UnlistenFn> {
  return listen("tray:lights-off", () => onTrigger());
}

/** Listen for the tray "Resume last mode" quick action. */
export async function listenTrayResumeLastMode(
  onTrigger: () => void
): Promise<UnlistenFn> {
  return listen("tray:resume-last-mode", () => onTrigger());
}

/** Listen for the tray "Solid color" quick action. */
export async function listenTraySolidColor(
  onTrigger: () => void
): Promise<UnlistenFn> {
  return listen("tray:solid-color", () => onTrigger());
}

/**
 * v1.6 — listen for the "Show LED Preview" tray action. The Rust tray handler
 * emits `tray:show-led-preview`; the app responds by opening (or focusing) the
 * control popup plus, when enabled, the digital-twin overlay.
 */
export async function listenTrayShowLedPreview(
  onTrigger: () => void
): Promise<UnlistenFn> {
  return listen("tray:show-led-preview", () => onTrigger());
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
