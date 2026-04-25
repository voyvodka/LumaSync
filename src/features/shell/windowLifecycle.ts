/**
 * Window Lifecycle
 *
 * Handles close-to-tray interception and one-time tray hint logic.
 * Uses plugin-store for persisting the `trayHintShown` flag.
 *
 * Usage: call `initWindowLifecycle()` once during app bootstrap.
 */

import { getCurrentWindow, availableMonitors, LogicalSize, LogicalPosition, PhysicalPosition } from "@tauri-apps/api/window";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { load } from "@tauri-apps/plugin-store";
import {
  SHELL_STORE_KEY,
  SHELL_STATE_SCHEMA_VERSION,
  DEFAULT_SHELL_STATE,
  UI_MODE_SIZES,
  UI_MODE_MIN_SIZES,
  type ShellState,
  type UIMode,
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
  const saved = await store.get<Partial<ShellState>>(SHELL_STORE_KEY);
  if (!saved) return { ...DEFAULT_SHELL_STATE };

  // Merge with defaults to handle new fields added in future phases.
  const merged: ShellState = {
    ...DEFAULT_SHELL_STATE,
    ...saved,
    schemaVersion: saved.schemaVersion ?? SHELL_STATE_SCHEMA_VERSION,
  };

  // Legacy state (pre-v1.5) had no `schemaVersion`. Write the migrated shape
  // back once so subsequent reads skip this branch — idempotent because the
  // second load sees `saved.schemaVersion === 1` and returns early.
  if (saved.schemaVersion === undefined) {
    await store.set(SHELL_STORE_KEY, merged);
  }

  return merged;
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
let unlistenMove: UnlistenFn | null = null;
let unlistenResize: UnlistenFn | null = null;
let lifecycleInitPromise: Promise<void> | null = null;

const GEOMETRY_PERSIST_DEBOUNCE_MS = 180;
let geometryPersistTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * True while `resizeToMode` is animating the window. Geometry persistence is
 * suppressed during this window so an intermediate animation frame can't be
 * written to disk as if it were the user's chosen size. The animator persists
 * the final rect itself once the transition settles.
 */
let isAnimatingMode = false;

function schedulePersistWindowState(): void {
  if (isAnimatingMode) return;

  if (geometryPersistTimer) {
    clearTimeout(geometryPersistTimer);
  }

  geometryPersistTimer = setTimeout(() => {
    geometryPersistTimer = null;
    void persistWindowState();
  }, GEOMETRY_PERSIST_DEBOUNCE_MS);
}

function cancelPendingGeometryPersist(): void {
  if (geometryPersistTimer) {
    clearTimeout(geometryPersistTimer);
    geometryPersistTimer = null;
  }
}

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

  unlistenCloseToTray = await listen("shell:close-to-tray", async () => {
    await persistWindowState();

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

interface WindowRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface MonitorRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Zero margin: flush-edge positions (x=0, y=0) are valid on macOS.
// The OS enforces its own constraints (menu bar, dock) natively.
const WINDOW_EDGE_MARGIN = 0;

function buildMonitorRect(monitor: { position: { x: number; y: number }; size: { width: number; height: number } }): MonitorRect {
  return {
    x: monitor.position.x,
    y: monitor.position.y,
    width: monitor.size.width,
    height: monitor.size.height,
  };
}

function isRectFullyInsideMonitor(rect: WindowRect, monitor: MonitorRect): boolean {
  const minX = monitor.x + WINDOW_EDGE_MARGIN;
  const minY = monitor.y + WINDOW_EDGE_MARGIN;
  const maxX = monitor.x + monitor.width - WINDOW_EDGE_MARGIN;
  const maxY = monitor.y + monitor.height - WINDOW_EDGE_MARGIN;

  return rect.x >= minX
    && rect.y >= minY
    && rect.x + rect.width <= maxX
    && rect.y + rect.height <= maxY;
}

function clampRectIntoMonitor(rect: WindowRect, monitor: MonitorRect): WindowRect {
  const maxX = monitor.x + monitor.width - WINDOW_EDGE_MARGIN;
  const maxY = monitor.y + monitor.height - WINDOW_EDGE_MARGIN;
  const minX = monitor.x + WINDOW_EDGE_MARGIN;
  const minY = monitor.y + WINDOW_EDGE_MARGIN;

  const maxAllowedX = Math.max(minX, maxX - rect.width);
  const maxAllowedY = Math.max(minY, maxY - rect.height);

  return {
    ...rect,
    x: Math.min(Math.max(rect.x, minX), maxAllowedX),
    y: Math.min(Math.max(rect.y, minY), maxAllowedY),
  };
}

function squaredDistance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return (dx * dx) + (dy * dy);
}

function pickNearestMonitor(rect: WindowRect, monitors: MonitorRect[]): MonitorRect | null {
  if (monitors.length === 0) {
    return null;
  }

  const rectCenter = {
    x: rect.x + (rect.width / 2),
    y: rect.y + (rect.height / 2),
  };

  return monitors.reduce((best, monitor) => {
    const monitorCenter = {
      x: monitor.x + (monitor.width / 2),
      y: monitor.y + (monitor.height / 2),
    };

    if (!best) {
      return monitor;
    }

    const bestCenter = {
      x: best.x + (best.width / 2),
      y: best.y + (best.height / 2),
    };

    return squaredDistance(rectCenter, monitorCenter) < squaredDistance(rectCenter, bestCenter)
      ? monitor
      : best;
  }, null as MonitorRect | null);
}

async function ensureWindowRectOnScreen(rect: WindowRect): Promise<WindowRect | null> {
  const monitors = (await availableMonitors()).map(buildMonitorRect);
  if (monitors.length === 0) {
    return null;
  }

  const alreadyVisible = monitors.some((monitor) => isRectFullyInsideMonitor(rect, monitor));
  if (alreadyVisible) {
    return rect;
  }

  const nearest = pickNearestMonitor(rect, monitors);
  if (!nearest) {
    return null;
  }

  return clampRectIntoMonitor(rect, nearest);
}

async function ensureCurrentWindowOnScreen(win: ReturnType<typeof getCurrentWindow>): Promise<void> {
  const { x, y } = await win.outerPosition();
  const { width, height } = await win.outerSize();
  const nextRect = await ensureWindowRectOnScreen({ x, y, width, height });

  if (!nextRect) {
    await win.center();
    const centeredPosition = await win.outerPosition();
    const centeredSize = await win.innerSize();
    await saveShellState({
      windowX: centeredPosition.x,
      windowY: centeredPosition.y,
      windowWidth: centeredSize.width,
      windowHeight: centeredSize.height,
    });
    return;
  }

  const moved = nextRect.x !== x || nextRect.y !== y;
  if (moved) {
    await win.setPosition(new PhysicalPosition(nextRect.x, nextRect.y));
    await saveShellState({
      windowX: nextRect.x,
      windowY: nextRect.y,
      windowWidth: nextRect.width,
      windowHeight: nextRect.height,
    });
  }
}

// ---------------------------------------------------------------------------
// Window position restoration
// ---------------------------------------------------------------------------

/**
 * Restore window position from persisted shell state.
 *
 * SIZE is intentionally NOT restored here: every launch starts in compact
 * mode (see `initWindowLifecycle`), and the Tauri window is already created
 * at compact dimensions via tauri.conf.json. Writing a persisted full-mode
 * size here would produce a visible big→compact flash before React mounts.
 *
 * Falls back to a safe centered position if saved coords are off-screen.
 */
export async function restoreWindowState(): Promise<void> {
  const win = getCurrentWindow();
  const state = await loadShellState();

  // Restore position (with monitor-bounds guard)
  if (state.windowX !== null && state.windowY !== null) {
    const currentSize = await win.outerSize();
    const candidateRect: WindowRect = {
      x: state.windowX,
      y: state.windowY,
      width: state.windowWidth ?? currentSize.width,
      height: state.windowHeight ?? currentSize.height,
    };

    const adjustedRect = await ensureWindowRectOnScreen(candidateRect);
    if (adjustedRect) {
      await win.setPosition(new PhysicalPosition(adjustedRect.x, adjustedRect.y));

      if (adjustedRect.x !== state.windowX || adjustedRect.y !== state.windowY) {
        await saveShellState({ windowX: adjustedRect.x, windowY: adjustedRect.y });
      }
    } else {
      await win.center();
      const centeredPosition = await win.outerPosition();
      await saveShellState({ windowX: centeredPosition.x, windowY: centeredPosition.y });
    }
  } else {
    // First launch (or legacy state without explicit position): if any plugin
    // restored an off-screen geometry, pull it back into view.
    await ensureCurrentWindowOnScreen(win);
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
// UI Mode resize
// ---------------------------------------------------------------------------

/** Duration of the animated window resize between UI modes. */
const UI_MODE_RESIZE_DURATION_MS = 220;

/**
 * Apply the per-mode minimum window size (logical px). Keeps the OS-level
 * resize handles from letting the user drag the window smaller than each
 * mode's supported floor.
 */
async function applyModeMinSize(
  win: ReturnType<typeof getCurrentWindow>,
  mode: UIMode,
): Promise<void> {
  const min = UI_MODE_MIN_SIZES[mode];
  await win.setMinSize(new LogicalSize(min.width, min.height));
}

/** Read the current main-window inner size in LOGICAL (DPI-independent) px. */
export async function getCurrentLogicalSize(): Promise<{ width: number; height: number }> {
  const win = getCurrentWindow();
  const scaleFactor = await win.scaleFactor();
  const { width, height } = await win.innerSize();
  return {
    width: Math.round(width / scaleFactor),
    height: Math.round(height / scaleFactor),
  };
}

/**
 * Resolve the target logical size the main window will have when it enters
 * `mode`. Mirrors the sizing logic in `resizeToMode`:
 *  - Entering "full" restores the user's last full-mode size when known.
 *  - Otherwise the default from `UI_MODE_SIZES` is used.
 */
export async function getTargetModeSize(mode: UIMode): Promise<{ width: number; height: number }> {
  const state = await loadShellState();
  if (mode === "full" && state.lastFullSize) {
    return { ...state.lastFullSize };
  }
  const defaults = UI_MODE_SIZES[mode];
  return { width: defaults.width, height: defaults.height };
}

/** easeOutCubic — fast start, gentle settle. */
function easeOutCubic(t: number): number {
  const clamped = Math.max(0, Math.min(1, t));
  return 1 - Math.pow(1 - clamped, 3);
}

function nextFrame(): Promise<number> {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

/**
 * Animate window size + position from a start rect to a target rect over
 * `durationMs`. Each frame awaits the IPC round-trip so calls don't pile up.
 *
 * All values are LOGICAL pixels (DPI-independent).
 */
async function animateWindowRect(
  win: ReturnType<typeof getCurrentWindow>,
  from: { width: number; height: number; x: number; y: number },
  to: { width: number; height: number; x: number; y: number },
  durationMs: number,
): Promise<void> {
  const start = performance.now();

  while (true) {
    const now = performance.now();
    const t = Math.min(1, (now - start) / durationMs);
    const eased = easeOutCubic(t);

    const w = Math.round(from.width + (to.width - from.width) * eased);
    const h = Math.round(from.height + (to.height - from.height) * eased);
    const x = Math.round(from.x + (to.x - from.x) * eased);
    const y = Math.round(from.y + (to.y - from.y) * eased);

    await Promise.all([
      win.setSize(new LogicalSize(w, h)),
      win.setPosition(new LogicalPosition(x, y)),
    ]);

    if (t >= 1) return;
    await nextFrame();
  }
}

/**
 * Animate the main window to match the given UI mode and persist the choice.
 *
 * Full-size memory:
 *  - Leaving "full" → captures current size into `lastFullSize` (logical px).
 *  - Entering "full" → restores `lastFullSize` if present, else uses
 *    the default UI_MODE_SIZES.full.
 *
 * The window is anchored to its current center point — it grows/shrinks in
 * place rather than jumping to monitor center. Final position is clamped
 * inside the nearest monitor so we never animate off-screen.
 */
export async function resizeToMode(mode: UIMode): Promise<void> {
  const win = getCurrentWindow();
  const currentState = await loadShellState();
  const currentMode: UIMode = currentState.uiMode ?? "compact";

  const partialUpdate: Partial<ShellState> = { uiMode: mode };

  // Read current logical rect (size + position).
  const scaleFactor = await win.scaleFactor();
  const innerPhys = await win.innerSize();
  const outerPos = await win.outerPosition();
  const fromWidth = Math.round(innerPhys.width / scaleFactor);
  const fromHeight = Math.round(innerPhys.height / scaleFactor);
  const fromX = Math.round(outerPos.x / scaleFactor);
  const fromY = Math.round(outerPos.y / scaleFactor);

  // Capture current full-mode size before leaving full mode.
  if (currentMode === "full" && mode !== "full") {
    partialUpdate.lastFullSize = { width: fromWidth, height: fromHeight };
  }

  // Determine target size.
  let targetWidth: number;
  let targetHeight: number;
  if (mode === "full" && currentState.lastFullSize) {
    targetWidth = currentState.lastFullSize.width;
    targetHeight = currentState.lastFullSize.height;
  } else {
    const defaults = UI_MODE_SIZES[mode];
    targetWidth = defaults.width;
    targetHeight = defaults.height;
  }

  // Anchor target around the current window center so the window grows/shrinks
  // in place instead of teleporting to monitor center.
  const centerX = fromX + fromWidth / 2;
  const centerY = fromY + fromHeight / 2;
  let targetX = Math.round(centerX - targetWidth / 2);
  let targetY = Math.round(centerY - targetHeight / 2);

  // Clamp the target rect inside the nearest monitor (logical px). The
  // monitor helpers operate on physical px, so convert through scaleFactor.
  const targetPhysRect: WindowRect = {
    x: Math.round(targetX * scaleFactor),
    y: Math.round(targetY * scaleFactor),
    width: Math.round(targetWidth * scaleFactor),
    height: Math.round(targetHeight * scaleFactor),
  };
  const adjustedPhys = await ensureWindowRectOnScreen(targetPhysRect);
  if (adjustedPhys) {
    targetX = Math.round(adjustedPhys.x / scaleFactor);
    targetY = Math.round(adjustedPhys.y / scaleFactor);
  }

  // Lower min-size to the smallest floor for the duration of the animation
  // so neither OS clamping nor Tauri's setSize call rejects intermediate
  // frames. The target mode's min-size is re-applied at the end.
  const animFloor = UI_MODE_MIN_SIZES.compact;
  await win.setMinSize(new LogicalSize(animFloor.width, animFloor.height));

  // Suppress debounced geometry persistence while the animator is driving
  // setSize/setPosition every frame — otherwise an intermediate frame could
  // be written to disk as the user's chosen window rect.
  isAnimatingMode = true;
  cancelPendingGeometryPersist();
  try {
    await animateWindowRect(
      win,
      { width: fromWidth, height: fromHeight, x: fromX, y: fromY },
      { width: targetWidth, height: targetHeight, x: targetX, y: targetY },
      UI_MODE_RESIZE_DURATION_MS,
    );
  } finally {
    isAnimatingMode = false;
    // Drop any trailing scheduled persist from onResized/onMoved events that
    // fired during the animation — we persist the authoritative final rect
    // explicitly below.
    cancelPendingGeometryPersist();
  }

  // Re-apply the target mode's min-size so OS resize handles enforce the floor.
  await applyModeMinSize(win, mode);

  await saveShellState(partialUpdate);
  await persistWindowState();
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
      // Every launch starts in compact — persisted uiMode is intentionally
      // ignored so the app opens with a predictable tray-style footprint.
      // `lastFullSize` is still honored later when the user toggles to full.
      //
      // The Tauri window is created at compact dimensions via tauri.conf.json
      // (320×480, visible: false). `tauri-plugin-window-state` is registered
      // with `skip_initial_state("main")` so it does NOT auto-restore size
      // or visibility — only position is restored here, from our own
      // shellStore, which means the user never sees a big→compact flash.
      const win = getCurrentWindow();
      // Launch always starts in compact (see comment above) — enforce its
      // floor so OS resize handles respect the compact min from frame 0.
      // If the user toggles to full later, `resizeToMode` will raise the
      // floor to full's min when that transition completes.
      await applyModeMinSize(win, "compact");
      await restoreWindowState();
      await win.show();
      // Force the window to the front on launch. Without this, on some
      // window managers (notably macOS after a cold launch with other
      // apps already in focus) `show()` reveals the window below the
      // active program, so the user has to click the dock icon to bring
      // it forward. `setFocus` explicitly makes the window key/active.
      // `unminimize` is a no-op on a freshly shown window but covers the
      // case where the window was last closed while minimized.
      try {
        await win.unminimize();
      } catch {
        // Some platforms throw if the window isn't minimized — ignore.
      }
      try {
        await win.setFocus();
      } catch {
        // Non-fatal: focus is cosmetic. Never let a capability/platform
        // failure here reject the lifecycle promise, because App.tsx
        // bootstrap awaits it before loading calibration, targets, and
        // Hue auto-start — an uncaught rejection here would skip all
        // of that and surface as "calibration required / Hue offline".
      }
      await initWindowGeometryPersistence();
      await initCloseToTrayHint(opts?.onFirstCloseToTray);
    })();
  }

  await lifecycleInitPromise;
}
