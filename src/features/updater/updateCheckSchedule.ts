import type { BackgroundCheckOutcome } from "./useAutoUpdater";

/** A tray app can run for weeks; one check per launch left those users behind. */
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * After a failed check: the startup check fails on every boot that beats the
 * network (a laptop waking on Wi-Fi), so it tries again soon and then backs off.
 * Once these run out the daily interval takes over.
 */
export const UPDATE_CHECK_RETRY_DELAYS_MS: readonly number[] = [60_000, 5 * 60_000, 15 * 60_000];

/**
 * Timers are re-armed at most this far ahead and the deadline is compared
 * against the wall clock: a sleeping machine does not advance a pending
 * `setTimeout` on every platform, and a 24 h timer would drift by every night
 * the laptop spent closed.
 */
export const UPDATE_CHECK_TICK_MS = 60 * 60 * 1000;

/** How long after a check with `outcome` the next one is due, or `null` for none. */
export function nextCheckDelayMs(outcome: BackgroundCheckOutcome, failuresInARow: number): number | null {
  if (outcome === "off") return null;
  if (outcome === "done") return UPDATE_CHECK_INTERVAL_MS;
  return UPDATE_CHECK_RETRY_DELAYS_MS[failuresInARow - 1] ?? UPDATE_CHECK_INTERVAL_MS;
}

export interface UpdateCheckScheduler {
  /** Runs the first check, or re-arms after `stop`. Idempotent. */
  start: () => void;
  /** Clears the pending timer; a check in flight finishes but schedules nothing. */
  stop: () => void;
}

export interface SchedulerClock {
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => number;
  clearTimeout: (id: number) => void;
}

const windowClock: SchedulerClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeout: (id) => window.clearTimeout(id),
};

/**
 * One chain of background checks: never two at once, never a timer left behind.
 * `stop` then `start` — StrictMode's double mount — resumes the same chain
 * instead of checking twice.
 */
export function createUpdateCheckScheduler(
  check: () => Promise<BackgroundCheckOutcome>,
  clock: SchedulerClock = windowClock,
): UpdateCheckScheduler {
  let running = false;
  let started = false;
  let inFlight = false;
  let dueAt: number | null = null;
  let failures = 0;
  let timerId: number | null = null;

  const clearTimer = () => {
    if (timerId !== null) clock.clearTimeout(timerId);
    timerId = null;
  };

  const arm = () => {
    clearTimer();
    if (!running || inFlight || dueAt === null) return;
    const remaining = dueAt - clock.now();
    if (remaining <= 0) {
      void run();
      return;
    }
    timerId = clock.setTimeout(arm, Math.min(remaining, UPDATE_CHECK_TICK_MS));
  };

  const run = async () => {
    inFlight = true;
    dueAt = null;
    let outcome: BackgroundCheckOutcome;
    try {
      outcome = await check();
    } catch (err) {
      // The check reports its own failures; this is the schedule's last resort.
      console.error("[LumaSync] background update check threw:", err);
      outcome = "failed";
    }
    inFlight = false;
    failures = outcome === "failed" ? failures + 1 : 0;
    const delay = nextCheckDelayMs(outcome, failures);
    if (delay === null) return;
    dueAt = clock.now() + delay;
    arm();
  };

  return {
    start: () => {
      running = true;
      if (!started) {
        started = true;
        void run();
        return;
      }
      arm();
    },
    stop: () => {
      running = false;
      clearTimer();
    },
  };
}
