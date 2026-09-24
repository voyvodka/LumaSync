/**
 * Tray Controller
 *
 * Frontend bridge for tray menu actions:
 * - Show LED Preview: opens the control popup (the lighting items — off,
 *   resume, solid — run the lighting transaction in Rust, never in a window)
 * - Label i18n: push translated strings to Rust via update_tray_labels
 * - Startup toggle: managed via plugin-autostart (no tray checkbox)
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

/**
 * Listen for startup state changes emitted from Rust (legacy: was triggered
 * by tray checkbox click). Now emitted only on external autostart changes.
 */
export async function listenStartupToggle(
  onToggle: (newState: boolean) => void
): Promise<UnlistenFn> {
  return listen<boolean>(TRAY_EVENTS.STARTUP_STATE_CHANGED, (event) => {
    onToggle(event.payload);
  });
}

// ---------------------------------------------------------------------------
// Re-export tray menu IDs for consumer convenience
// ---------------------------------------------------------------------------
export { TRAY_MENU_IDS };
