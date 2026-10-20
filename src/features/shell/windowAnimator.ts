/**
 * The animated window resize between UI modes. `useUIMode` owns the fade
 * around it; this owns the window rect, the per-mode min size and the
 * full-size memory.
 */

import { getCurrentWindow, LogicalSize, LogicalPosition } from "@tauri-apps/api/window";
import {
  UI_MODE_SIZES,
  UI_MODE_MIN_SIZES,
  resolveUiZoom,
  type ShellState,
  type UIMode,
} from "@/shared/contracts/shell";
import { clamp } from "@/shared/lib/math";
import { waitForFrames } from "./frameWait";
import {
  cancelPendingGeometryPersist,
  ensureWindowRectOnScreen,
  firstRunFullSize,
  fitSizeToWorkArea,
  logicalWorkAreaNear,
  persistWindowState,
  scaleSize,
  setModeAnimationActive,
  type WindowRect,
} from "./windowGeometry";
import { loadShellState, saveShellState } from "./windowShellState";

// ---------------------------------------------------------------------------
// UI Mode resize
// ---------------------------------------------------------------------------

/** Duration of the animated window resize between UI modes. */
const UI_MODE_RESIZE_DURATION_MS = 220;

/** The interface size the window's frame was last sized for. */
let framedZoom = 1;

export function framedUiZoom(): number {
  return framedZoom;
}

export function noteFramedUiZoom(zoom: number): void {
  framedZoom = zoom;
}

/**
 * Apply the per-mode window limits: the minimum size (logical px), which keeps
 * the OS-level resize handles from letting the user drag the window smaller than
 * each mode's supported floor, and whether the window may be zoomed.
 */
export async function applyModeLimits(
  win: ReturnType<typeof getCurrentWindow>,
  mode: UIMode,
  workArea?: { width: number; height: number } | null,
  zoom = 1,
): Promise<void> {
  // A floor larger than the screen is worse than no floor: the OS refuses every
  // resize below it, so the window cannot be made to fit at all.
  const min = fitSizeToWorkArea(scaleSize(UI_MODE_MIN_SIZES[mode], zoom), workArea ?? null);
  await win.setMinSize(new LogicalSize(min.width, min.height));
  // Compact is a fixed layout. Tauri gates the title bar's double-click on the same flag.
  await win.setMaximizable(mode === "full");
}

/** Frames an unzoom may take to show before the rect is read anyway. */
const UNZOOM_SETTLE_FRAMES = 30;

/** Unzooms and waits until the window says so: GTK's goes through the window manager. */
async function unzoom(win: ReturnType<typeof getCurrentWindow>): Promise<void> {
  await win.unmaximize();
  for (let frame = 0; frame < UNZOOM_SETTLE_FRAMES; frame++) {
    if (!(await win.isMaximized().catch(() => false))) break;
    await waitForFrames(1);
  }
  await waitForFrames(1);
}

/** Under every floor the app sets is a minimized window's frame, which no user chose: the first-run size replaces it. */
function rememberedFullSize(
  size: { width: number; height: number } | null | undefined,
): { width: number; height: number } | null {
  if (!size) return null;
  const floor = UI_MODE_MIN_SIZES.compact;
  return size.width < floor.width || size.height < floor.height ? null : size;
}

function atLeast(
  size: { width: number; height: number },
  floor: { width: number; height: number },
): { width: number; height: number } {
  return { width: Math.max(size.width, floor.width), height: Math.max(size.height, floor.height) };
}

/** easeOutCubic — fast start, gentle settle. */
function easeOutCubic(t: number): number {
  const clamped = clamp(t, 0, 1);
  return 1 - Math.pow(1 - clamped, 3);
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
  // Once per animation: a destroyed window fails every remaining frame, and a
  // line per frame would flood the log sink at display rate.
  let frameErrorLogged = false;
  const logFrameError = (error: unknown) => {
    if (frameErrorLogged) return;
    frameErrorLogged = true;
    console.warn(
      "[LumaSync] window resize animation: an intermediate frame failed (further frame errors in this animation are not logged):",
      error,
    );
  };

  while (true) {
    const now = performance.now();
    const t = Math.min(1, (now - start) / durationMs);
    const eased = easeOutCubic(t);

    const w = Math.round(from.width + (to.width - from.width) * eased);
    const h = Math.round(from.height + (to.height - from.height) * eased);
    const x = Math.round(from.x + (to.x - from.x) * eased);
    const y = Math.round(from.y + (to.y - from.y) * eased);

    if (t >= 1) {
      // Final frame: await IPC to ensure state consistency
      await Promise.all([
        win.setSize(new LogicalSize(w, h)),
        win.setPosition(new LogicalPosition(x, y)),
      ]);
      return;
    } else {
      // Intermediate frames: fire-and-forget to avoid stuttering from IPC
      // round-trips. A rejection (e.g. the window destroyed mid-animation) is
      // caught so it is not unhandled, and logged rather than swallowed.
      win.setSize(new LogicalSize(w, h)).catch(logFrameError);
      win.setPosition(new LogicalPosition(x, y)).catch(logFrameError);
    }

    // Bounded: while hidden the frames never come, and `t` is wall-clock, so
    // the loop still reaches its final rect.
    await waitForFrames(1);
  }
}

/**
 * Animate the main window to match the given UI mode and persist the choice.
 *
 * Full-size memory:
 *  - Leaving "full" → captures current size into `lastFullSize` (logical px).
 *  - Entering "full" → restores `lastFullSize` if present, else sizes the
 *    window to the screen via `firstRunFullSize`.
 *
 * The window is anchored to its current center point — it grows/shrinks in
 * place rather than jumping to monitor center. Final position is clamped
 * inside the nearest monitor so we never animate off-screen.
 *
 * Interface size: compact has one fixed size, so it scales with the zoom and
 * its layout keeps the 320×480 viewport. Full keeps the size the user gave it
 * and only grows to the zoomed floor, so its viewport never drops below the
 * width its layouts are built for. `zoom` and `fromZoom` are passed on a size
 * change, whose save may not have landed yet.
 *
 * The launch passes the state it already read and `persist: false`: the mode it grows to is the
 * saved one, so a save would only rewrite what is on disk, twice, on the way to the first frame.
 */
export async function resizeToMode(
  mode: UIMode,
  opts?: { animate?: boolean; zoom?: number; fromZoom?: number; state?: ShellState; persist?: boolean },
): Promise<void> {
  const win = getCurrentWindow();
  const currentState = opts?.state ?? (await loadShellState());
  const currentMode: UIMode = currentState.uiMode ?? "compact";
  const zoom = opts?.zoom ?? resolveUiZoom(currentState.uiZoom) / 100;
  const fromZoom = opts?.fromZoom ?? zoom;

  const partialUpdate: Partial<ShellState> = { uiMode: mode };

  // The rect read below has to be the user's, not a zoomed window's screen-sized one. macOS unzooms
  // as an animation that outlasts `unmaximize`, so there the size remembered before the zoom stays.
  const leavingFull = currentMode === "full" && mode !== "full";
  const zoomed = leavingFull && (await win.isMaximized().catch(() => false));
  // Read here, not through `detectPlatform`: importing `windowDragApi` would put it in every window's entry.
  const keepRememberedSize = zoomed && /Mac/i.test(navigator.userAgent);
  if (zoomed && !keepRememberedSize) await unzoom(win);

  // Read current logical rect (size + position).
  const scaleFactor = await win.scaleFactor();
  const innerPhys = await win.innerSize();
  const outerPos = await win.outerPosition();
  const fromWidth = Math.round(innerPhys.width / scaleFactor);
  const fromHeight = Math.round(innerPhys.height / scaleFactor);
  const fromX = Math.round(outerPos.x / scaleFactor);
  const fromY = Math.round(outerPos.y / scaleFactor);

  // Capture current full-mode size before leaving full mode.
  if (leavingFull && !keepRememberedSize) {
    partialUpdate.lastFullSize = { width: fromWidth, height: fromHeight };
  }
  const rescalingFull = currentMode === "full" && mode === "full" && fromZoom !== zoom;

  // Neither the 900×620 full default nor a size remembered from a larger
  // display is checked against the screen it is about to land on.
  const workArea = await logicalWorkAreaNear(
    {
      x: Math.round(fromX * scaleFactor),
      y: Math.round(fromY * scaleFactor),
      width: Math.round(fromWidth * scaleFactor),
      height: Math.round(fromHeight * scaleFactor),
    },
    scaleFactor,
  );

  const requested = mode === "full"
    ? atLeast(
        rescalingFull
          ? { width: fromWidth, height: fromHeight }
          : rememberedFullSize(currentState.lastFullSize) ?? scaleSize(firstRunFullSize(workArea ? scaleSize(workArea, 1 / zoom) : null), zoom),
        scaleSize(UI_MODE_MIN_SIZES.full, zoom),
      )
    : scaleSize(UI_MODE_SIZES[mode], zoom);
  const { width: targetWidth, height: targetHeight } = fitSizeToWorkArea(requested, workArea);

  // Anchor target around the current window center so the window grows/shrinks
  // in place instead of teleporting to monitor center. Both halves floor, so a compact round trip
  // is exactly reversible.
  const centerX = fromX + Math.floor(fromWidth / 2);
  const centerY = fromY + Math.floor(fromHeight / 2);
  let targetX = centerX - Math.floor(targetWidth / 2);
  let targetY = centerY - Math.floor(targetHeight / 2);

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
  const animFloor = scaleSize(UI_MODE_MIN_SIZES.compact, Math.min(zoom, fromZoom));
  await win.setMinSize(new LogicalSize(animFloor.width, animFloor.height));

  // Suppress debounced geometry persistence while the animator is driving
  // setSize/setPosition every frame — otherwise an intermediate frame could
  // be written to disk as the user's chosen window rect.
  setModeAnimationActive(true);
  cancelPendingGeometryPersist();
  try {
    if (opts?.animate === false) {
      // Boot restores the persisted mode while the window is still hidden, so
      // there is nothing to animate — and `animateWindowRect` cannot be handed
      // a zero duration, since `t` would be NaN and the loop would never exit.
      await Promise.all([
        win.setSize(new LogicalSize(targetWidth, targetHeight)),
        win.setPosition(new LogicalPosition(targetX, targetY)),
      ]);
    } else {
      await animateWindowRect(
        win,
        { width: fromWidth, height: fromHeight, x: fromX, y: fromY },
        { width: targetWidth, height: targetHeight, x: targetX, y: targetY },
        UI_MODE_RESIZE_DURATION_MS,
      );
    }
  } finally {
    setModeAnimationActive(false);
    // Drop any trailing scheduled persist from onResized/onMoved events that
    // fired during the animation — we persist the authoritative final rect
    // explicitly below.
    cancelPendingGeometryPersist();
  }

  // Re-apply the target mode's min-size so OS resize handles enforce the floor.
  await applyModeLimits(win, mode, workArea, zoom);
  framedZoom = zoom;

  if (opts?.persist === false) return;
  // The window already has the new size: a failed write must not throw out before the layout swaps,
  // or a 320 px window keeps the full layout. The write-failing notice says it; the next write retries.
  try {
    await saveShellState(partialUpdate);
    await persistWindowState({ captureSize: false });
  } catch (err) {
    console.error("[LumaSync] saving the window mode failed:", err);
  }
}
