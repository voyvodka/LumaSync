/**
 * Window geometry: the monitor-bounds guard, the centre-anchored restore and
 * persist of the main window's position, the size helpers the mode resize
 * reads, and the debounced persistence behind the move/resize listeners.
 */

import { getCurrentWindow, availableMonitors, PhysicalPosition } from "@tauri-apps/api/window";
import { UI_MODE_SIZES, type ShellState } from "@/shared/contracts/shell";
import { clamp } from "@/shared/lib/math";
import { loadShellState, saveShellState } from "./windowShellState";

// ---------------------------------------------------------------------------
// Monitor bounds guard
// ---------------------------------------------------------------------------

export interface WindowRect {
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

interface MonitorInfo {
  position: { x: number; y: number };
  size: { width: number; height: number };
  workArea?: { position: { x: number; y: number }; size: { width: number; height: number } };
}

function buildMonitorRect(monitor: MonitorInfo): MonitorRect {
  return {
    x: monitor.position.x,
    y: monitor.position.y,
    width: monitor.size.width,
    height: monitor.size.height,
  };
}

/** Full bounds when the platform reports no work area — the size clamp is a
 *  safety net, and a missing dock inset must not turn it into a no-op. */
function buildWorkAreaRect(monitor: MonitorInfo): MonitorRect {
  const area = monitor.workArea;
  if (!area) return buildMonitorRect(monitor);
  return {
    x: area.position.x,
    y: area.position.y,
    width: area.size.width,
    height: area.size.height,
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

/** Shrink-only, and exported for tests: a window taller than the screen puts its
 *  own resize grip out of reach. Growing to fill a large display is a taste call
 *  the persisted full size already answers. */
export function fitSizeToWorkArea(
  size: { width: number; height: number },
  workArea: { width: number; height: number } | null,
): { width: number; height: number } {
  if (!workArea) return { ...size };
  return {
    width: Math.min(size.width, workArea.width),
    height: Math.min(size.height, workArea.height),
  };
}

/** Share of the work area a first-run full window takes, and the most it may
 *  scale past the 900×620 design size. 62% leaves visible desktop on every side
 *  so the window reads as a panel rather than a maximised app; the cap keeps a
 *  4K@1x or ultrawide from stretching settings rows to 2000 px. */
const FIRST_RUN_FULL_FRACTION = 0.62;
const FIRST_RUN_FULL_MAX_SCALE = 1.6;

/** Full-mode size when nothing is persisted: `UI_MODE_SIZES.full` scaled
 *  uniformly (so the aspect holds) toward a fraction of the logical work area,
 *  never below the design size — `fitSizeToWorkArea` still has the last word
 *  on a screen smaller than that. */
export function firstRunFullSize(
  workArea: { width: number; height: number } | null,
): { width: number; height: number } {
  const base = UI_MODE_SIZES.full;
  if (!workArea) return { ...base };
  const scale = clamp(
    Math.min(
      (workArea.width * FIRST_RUN_FULL_FRACTION) / base.width,
      (workArea.height * FIRST_RUN_FULL_FRACTION) / base.height,
    ),
    1,
    FIRST_RUN_FULL_MAX_SCALE,
  );
  return {
    width: Math.round(base.width * scale),
    height: Math.round(base.height * scale),
  };
}

/** Logical work area of the monitor nearest `rect`, or null when none is known. */
export async function logicalWorkAreaNear(
  rect: WindowRect,
  scaleFactor: number,
): Promise<{ width: number; height: number } | null> {
  const monitors: MonitorInfo[] = await availableMonitors();
  if (monitors.length === 0) return null;

  const bounds = monitors.map(buildMonitorRect);
  const nearest = pickNearestMonitor(rect, bounds);
  if (!nearest) return null;

  const monitor = monitors[bounds.indexOf(nearest)];
  if (!monitor) return null;

  const work = buildWorkAreaRect(monitor);
  return {
    width: Math.floor(work.width / scaleFactor),
    height: Math.floor(work.height / scaleFactor),
  };
}

export async function ensureWindowRectOnScreen(rect: WindowRect): Promise<WindowRect | null> {
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

// ---------------------------------------------------------------------------
// Center-anchored geometry helpers (shared by persist + restore paths)
// ---------------------------------------------------------------------------

/**
 * Compute the center point of a rectangle in physical pixels.
 *
 * Center is the persisted invariant: when the user repositions the window in
 * one mode (e.g. full 900×620), saving the *center* keeps the same visual
 * pixel pinned across mode toggles and across reboots — even though the boot
 * always starts in compact (see `initWindowLifecycle`). The top-left corner
 * is mode-dependent and would land a smaller compact window biased toward the
 * upper-left of where the user last placed it.
 */
function rectCenter(rect: { x: number; y: number; width: number; height: number }): { x: number; y: number } {
  return {
    x: rect.x + Math.round(rect.width / 2),
    y: rect.y + Math.round(rect.height / 2),
  };
}

/**
 * Compute the top-left corner of a rectangle from a center point and a size.
 *
 * Inverse of `rectCenter`. Used at restore time: we know the persisted center
 * and the *current* outer window size (boot-time compact), so the target
 * top-left is `center - size/2`.
 */
function rectTopLeftFromCenter(
  center: { x: number; y: number },
  size: { width: number; height: number },
): { x: number; y: number } {
  return {
    x: center.x - Math.round(size.width / 2),
    y: center.y - Math.round(size.height / 2),
  };
}

async function ensureCurrentWindowOnScreen(win: ReturnType<typeof getCurrentWindow>): Promise<void> {
  const { x, y } = await win.outerPosition();
  const { width, height } = await win.outerSize();
  const nextRect = await ensureWindowRectOnScreen({ x, y, width, height });

  if (!nextRect) {
    await win.center();
    const centeredPosition = await win.outerPosition();
    const centeredSize = await win.outerSize();
    const center = rectCenter({
      x: centeredPosition.x,
      y: centeredPosition.y,
      width: centeredSize.width,
      height: centeredSize.height,
    });
    await saveShellState({ windowCenterX: center.x, windowCenterY: center.y });
    return;
  }

  const moved = nextRect.x !== x || nextRect.y !== y;
  if (moved) {
    await win.setPosition(new PhysicalPosition(nextRect.x, nextRect.y));
    const center = rectCenter(nextRect);
    await saveShellState({ windowCenterX: center.x, windowCenterY: center.y });
  }
}

// ---------------------------------------------------------------------------
// Window position restoration
// ---------------------------------------------------------------------------

/**
 * Restore window position from persisted shell state.
 *
 * SIZE is not restored here — `initWindowLifecycle` does that afterwards, by
 * calling `resizeToMode` with the persisted mode. This runs at the window's
 * created (compact) dimensions, which is what the centre math below reads.
 *
 * Position uses a **center-anchored** model: the persisted `windowCenterX/Y`
 * is mode-invariant. We re-derive the top-left from that center and the
 * window's current outer size (compact at boot), then clamp the resulting
 * rect into the nearest monitor so a saved center on a now-disconnected
 * display is recovered to the closest visible screen.
 */
export async function restoreWindowState(): Promise<void> {
  const win = getCurrentWindow();
  const state = await loadShellState();

  if (state.windowCenterX !== null && state.windowCenterY !== null) {
    const currentSize = await win.outerSize();
    const topLeft = rectTopLeftFromCenter(
      { x: state.windowCenterX, y: state.windowCenterY },
      currentSize,
    );
    const candidateRect: WindowRect = {
      x: topLeft.x,
      y: topLeft.y,
      width: currentSize.width,
      height: currentSize.height,
    };

    const adjustedRect = await ensureWindowRectOnScreen(candidateRect);
    if (adjustedRect) {
      await win.setPosition(new PhysicalPosition(adjustedRect.x, adjustedRect.y));

      // If the monitor-bounds guard moved us, refresh the persisted center so
      // future restores converge on the visible position rather than fighting
      // the clamp every launch.
      if (adjustedRect.x !== candidateRect.x || adjustedRect.y !== candidateRect.y) {
        const center = rectCenter(adjustedRect);
        await saveShellState({ windowCenterX: center.x, windowCenterY: center.y });
      }
    } else {
      // No monitors available (rare; e.g. headless or all displays unplugged
      // during sleep). Fall back to the OS centering behavior and persist
      // whatever the OS chose.
      await win.center();
      const centeredPosition = await win.outerPosition();
      const centeredSize = await win.outerSize();
      const center = rectCenter({
        x: centeredPosition.x,
        y: centeredPosition.y,
        width: centeredSize.width,
        height: centeredSize.height,
      });
      await saveShellState({ windowCenterX: center.x, windowCenterY: center.y });
    }
  } else {
    // First launch (or migrated legacy state with all-null geometry): if any
    // plugin restored an off-screen geometry, pull it back into view.
    await ensureCurrentWindowOnScreen(win);
  }
}

/**
 * Persist current window geometry to shell state store.
 *
 * Saves the window **center** (physical px) computed from `outerPosition` +
 * `outerSize`. Using `outerSize` (not `innerSize`) means the center is
 * symmetric across the window decorations — restoring against a different
 * outer size on next launch (e.g. compact instead of full) lands the same
 * visual pixel as the center.
 *
 * Call this before hiding or on a debounced resize/move handler.
 */
export async function persistWindowState(
  opts?: { captureSize?: boolean },
): Promise<void> {
  const win = getCurrentWindow();
  const { width, height } = await win.outerSize();
  const { x, y } = await win.outerPosition();
  const center = rectCenter({ x, y, width, height });

  const update: Partial<ShellState> = {
    windowCenterX: center.x,
    windowCenterY: center.y,
  };

  // Only a user-driven resize records the size. `resizeToMode` opts out: it
  // owns `lastFullSize` itself, and at boot the window is still at its compact
  // size when this runs — capturing there wrote 320×452 over the remembered
  // full size. Logical *inner* px, matching what `resizeToMode` captures; the
  // outer rect would grow the window by the title bar every round trip.
  if (opts?.captureSize !== false) {
    const { uiMode } = await loadShellState();
    if ((uiMode ?? "compact") === "full") {
      update.lastFullSize = await getCurrentLogicalSize();
    }
  }

  await saveShellState(update);
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

// ---------------------------------------------------------------------------
// Debounced geometry persistence
// ---------------------------------------------------------------------------

const GEOMETRY_PERSIST_DEBOUNCE_MS = 180;
let geometryPersistTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * True while `resizeToMode` is animating the window. Geometry persistence is
 * suppressed during this window so an intermediate animation frame can't be
 * written to disk as if it were the user's chosen size. The animator persists
 * the final rect itself once the transition settles.
 */
let isAnimatingMode = false;

/** Raised and lowered by `resizeToMode` around its animation. */
export function setModeAnimationActive(active: boolean): void {
  isAnimatingMode = active;
}

export function schedulePersistWindowState(): void {
  if (isAnimatingMode) return;

  if (geometryPersistTimer) {
    clearTimeout(geometryPersistTimer);
  }

  geometryPersistTimer = setTimeout(() => {
    geometryPersistTimer = null;
    void persistWindowState();
  }, GEOMETRY_PERSIST_DEBOUNCE_MS);
}

export function cancelPendingGeometryPersist(): void {
  if (geometryPersistTimer) {
    clearTimeout(geometryPersistTimer);
    geometryPersistTimer = null;
  }
}
