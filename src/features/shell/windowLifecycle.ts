/**
 * Window Lifecycle
 *
 * Boots the main window — restore, show, listeners — and handles close-to-tray
 * interception and the one-time tray hint. The pieces it drives live beside it:
 * `windowShellState.ts` (the shell-state facade), `windowGeometry.ts` (bounds,
 * restore and persist) and `windowAnimator.ts` (the mode resize). Importers go
 * through this module, which re-exports what they use.
 *
 * Usage: call `initWindowLifecycle()` once during app bootstrap.
 */

import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { readStartHidden } from "./launchApi";
import { applyModeMinSize, resizeToMode } from "./windowAnimator";
import { persistWindowState, restoreWindowState, schedulePersistWindowState } from "./windowGeometry";
import { loadShellState, saveShellState } from "./windowShellState";

export { loadShellState, onShellStateSaved, saveShellState, type ShellStateSavedListener } from "./windowShellState";
export {
  fitSizeToWorkArea,
  firstRunFullSize,
  getCurrentLogicalSize,
  persistWindowState,
  restoreWindowState,
} from "./windowGeometry";
export { resizeToMode } from "./windowAnimator";

// CI's definition of "the build launches": `scripts/verify/launch-smoke.mjs`
// greps the app's stdout for this literal, which it reads back out of this file
// — so renaming the string is safe, inlining it at the call site is not.
export const STARTUP_READY_MARKER = "[LumaSync] [startup] shell ready";

// ---------------------------------------------------------------------------
// Close-to-tray one-time hint
// ---------------------------------------------------------------------------

/** Callback type for the tray hint display */
export type TrayHintCallback = () => void;

let unlistenCloseToTray: UnlistenFn | null = null;
let unlistenMove: UnlistenFn | null = null;
let unlistenResize: UnlistenFn | null = null;
let lifecycleInitPromise: Promise<void> | null = null;

async function initWindowGeometryPersistence(): Promise<void> {
  const win = getCurrentWindow();

  if (unlistenMove) {
    unlistenMove();
    unlistenMove = null;
  }

  if (unlistenResize) {
    unlistenResize();
    unlistenResize = null;
  }

  unlistenMove = await win.onMoved(() => {
    schedulePersistWindowState();
  });

  unlistenResize = await win.onResized(() => {
    schedulePersistWindowState();
  });
}

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

  unlistenCloseToTray = await listen("shell:close-to-tray", () => {
    void (async () => {
      try {
        await persistWindowState();

        const state = await loadShellState();
        if (!state.trayHintShown) {
          await saveShellState({ trayHintShown: true });
          onFirstClose?.();
        }
      } catch (err) {
        console.error("[LumaSync] close-to-tray: saving window state failed:", err);
      }
    })();
  });
}

// ---------------------------------------------------------------------------
// Full lifecycle init
// ---------------------------------------------------------------------------

/**
 * Initialize the full window lifecycle:
 * - Restore window state (size, position, UI mode)
 * - Show window (starts invisible to avoid flash)
 * - Register geometry persistence + close-to-tray listeners
 *
 * Call once during app bootstrap after i18n is ready so hints can be translated.
 */
export async function initWindowLifecycle(opts?: {
  onFirstCloseToTray?: TrayHintCallback;
}): Promise<void> {
  if (!lifecycleInitPromise) {
    lifecycleInitPromise = (async () => {
      const win = getCurrentWindow();
      // Compact's floor from frame 0; `resizeToMode` raises it on a toggle to full.
      await applyModeMinSize(win, "compact");
      await restoreWindowState();
      // Grow to the persisted mode around the restored centre, via the same path
      // a manual toggle takes. Still hidden, so nothing of this is visible.
      const { uiMode } = await loadShellState();
      if ((uiMode ?? "compact") !== "compact") {
        await resizeToMode(uiMode ?? "compact", { animate: false });
      }
      // Geometry is restored either way, so the first tray click opens the
      // window where it was left.
      if (await readStartHidden()) {
        console.info("[LumaSync] [startup] launched with --tray; staying in the tray");
      } else {
        await win.show();
        // `show()` alone can reveal the window *behind* the active app on a cold
        // launch (notably macOS), leaving the user to click the dock icon.
        try {
          await win.unminimize();
        } catch {
          // Some platforms throw if the window isn't minimized — ignore.
        }
        try {
          await win.setFocus();
        } catch {
          // Focus is cosmetic and must never reject this promise: bootstrap awaits
          // it before calibration, targets and Hue, so a throw here would surface
          // to the user as "calibration required / Hue offline".
        }
      }
      await initWindowGeometryPersistence();
      await initCloseToTrayHint(opts?.onFirstCloseToTray);
      // Last statement on purpose: everything above is awaited, so the beacon
      // cannot be reached by a launch that failed any step of it.
      console.info(STARTUP_READY_MARKER);
    })();
  }

  await lifecycleInitPromise;
}
