/**
 * Upper bound on one wait for animation frames. The webview stops firing
 * `requestAnimationFrame` while the window is hidden, occluded or the screen is
 * locked, so an unbounded wait strands whatever awaits it — see
 * docs/architecture/ui-and-shell.md. Well above a visible double paint (~33 ms
 * at 60 Hz, ~66 ms at a throttled 30 Hz) so it does not win on a slow frame,
 * and short enough that a switch made while hidden still finishes promptly.
 */
export const FRAME_WAIT_FALLBACK_MS = 250;

/**
 * Resolve after `frames` animation frames, or after `timeoutMs` if they do not
 * come. Whichever wins cancels the other, so a frame that arrives late (the
 * window becoming visible again) runs nothing.
 */
export function waitForFrames(
  frames: number,
  timeoutMs: number = FRAME_WAIT_FALLBACK_MS,
): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    let rafId: number | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      if (rafId !== null) cancelAnimationFrame(rafId);
      resolve();
    };

    let remaining = Math.max(1, frames);
    const onFrame = () => {
      rafId = null;
      remaining -= 1;
      if (remaining === 0) finish();
      else rafId = requestAnimationFrame(onFrame);
    };

    timer = setTimeout(finish, timeoutMs);
    rafId = requestAnimationFrame(onFrame);
  });
}
