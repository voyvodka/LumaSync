/**
 * Tray Controller
 *
 * Frontend bridge for tray menu actions:
 * - Show LED Preview: opens the control popup (the lighting items — off,
 *   resume, solid — run the lighting transaction in Rust, never in a window)
 * - Label i18n: push translated strings to Rust via update_tray_labels
 * - Launch at login: set via plugin-autostart (no tray checkbox)
 *
 * Tray menu ID and event-name constants are imported from shell contracts —
 * never hardcode strings here.
 */

import { enable, disable, isEnabled } from "@tauri-apps/plugin-autostart";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { TRAY_EVENTS, TRAY_MENU_IDS } from "@/shared/contracts/shell";

// ---------------------------------------------------------------------------
// Startup toggle (no tray checkbox — managed in System settings only)
// ---------------------------------------------------------------------------

/**
 * Set run-at-login to what the user asked for and return what the OS now
 * reports. Explicit, never a flip of the current state: a switch showing a
 * stale value used to turn autostart off when the user asked for on. Only
 * the Settings section changes it; the tray has no item for it.
 */
export async function setStartup(enabled: boolean): Promise<boolean> {
  if (enabled) await enable();
  else await disable();
  return isEnabled();
}

/** Read current autostart state */
export async function getStartupEnabled(): Promise<boolean> {
  return isEnabled();
}

// ---------------------------------------------------------------------------
// Tray quick action event listeners
// ---------------------------------------------------------------------------

/**
 * v1.6 — listen for the "Show LED Preview" tray action. The Rust tray handler
 * emits `tray:show-led-preview`; the app responds by opening (or focusing) the
 * control popup plus, when enabled, the digital-twin overlay.
 */
export async function listenTrayShowLedPreview(
  onTrigger: () => void
): Promise<UnlistenFn> {
  return listen(TRAY_EVENTS.SHOW_LED_PREVIEW, () => onTrigger());
}

// ---------------------------------------------------------------------------
// Re-export tray menu IDs for consumer convenience
// ---------------------------------------------------------------------------
export { TRAY_MENU_IDS };
