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
let unlistenMove: UnlistenFn | null = null;
let unlistenResize: UnlistenFn | null = null;
let lifecycleInitPromise: Promise<void> | null = null;

const GEOMETRY_PERSIST_DEBOUNCE_MS = 180;
let geometryPersistTimer: ReturnType<typeof setTimeout> | null = null;

function schedulePersistWindowState(): void {
  if (geometryPersistTimer) {
    clearTimeout(geometryPersistTimer);
  }

  geometryPersistTimer = setTimeout(() => {
    geometryPersistTimer = null;
    void persistWindowState();
  }, GEOMETRY_PERSIST_DEBOUNCE_MS);
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

const WINDOW_EDGE_MARGIN = 8;

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
 * Restore window position and size from persisted shell state.
 * Falls back to safe centered position if saved coords are off-screen.
 */
export async function restoreWindowState(): Promise<void> {
  const win = getCurrentWindow();
  const state = await loadShellState();
  const isLegacyDefaultSizeOnly =
    state.windowWidth === 900 &&
    state.windowHeight === 620 &&
    state.windowX === null &&
    state.windowY === null;

  // Restore size
  if (
    !isLegacyDefaultSizeOnly &&
    state.windowWidth !== null &&
    state.windowHeight !== null
  ) {
    await win.setSize(new PhysicalSize(state.windowWidth, state.windowHeight));
  }

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
  onFirstCloseToTray?: TrayHintCallback;
}): Promise<void> {
  if (!lifecycleInitPromise) {
    lifecycleInitPromise = (async () => {
      await restoreWindowState();
      await initWindowGeometryPersistence();
      await initCloseToTrayHint(opts?.onFirstCloseToTray);
    })();
  }

  await lifecycleInitPromise;
}
