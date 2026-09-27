/**
 * Shared runtime-telemetry poll loop. `useRuntimeTelemetry` and
 * `useFullTelemetryPoll` each ran their own 1 Hz loop against the SAME
 * command, doubling the IPC rate whenever both were mounted; they are now thin
 * subscribers over this one loop. Preserved from the per-hook versions:
 * recursive setTimeout (never overlapping calls), pause-while-hidden with an
 * immediate tick on resume, and last-known snapshot surviving a failed tick.
 * "Hidden" is `isWindowVisible`, not the document alone: WebView2 can report a
 * window hidden in the tray as visible.
 */

import type { FullTelemetrySnapshot, RuntimeTelemetryHistory } from "@/shared/contracts/telemetry";
import { getFullTelemetrySnapshot, getRuntimeTelemetryHistory } from "./telemetryApi";
import { parseCommandError } from "@/shared/contracts/status";
import { isWindowVisible, subscribeWindowVisible } from "@/features/shell/windowVisibility";

export interface TelemetrySourceState {
  snapshot: FullTelemetrySnapshot | null;
  /** Read on the same tick as the snapshot, and only while a subscriber asked for it. */
  history: RuntimeTelemetryHistory | null;
  /** Wall clock of the tick that read `history`, which the chart's time axis ends at. */
  historyReadAtMs: number | null;
  error: Error | null;
  isLoading: boolean;
}

export type TelemetrySourceListener = (state: TelemetrySourceState) => void;

const INITIAL_STATE: TelemetrySourceState = {
  snapshot: null,
  history: null,
  historyReadAtMs: null,
  error: null,
  isLoading: true,
};

interface Subscriber {
  intervalMs: number;
  listener: TelemetrySourceListener;
  history: boolean;
}

const subscribers = new Map<symbol, Subscriber>();

let state: TelemetrySourceState = INITIAL_STATE;
let timeoutId: number | null = null;
let inFlight = false;
let releaseVisibility: (() => void) | null = null;

function effectiveIntervalMs(): number {
  let min = Number.POSITIVE_INFINITY;
  for (const sub of subscribers.values()) {
    if (sub.intervalMs < min) min = sub.intervalMs;
  }
  return Number.isFinite(min) ? min : 1000;
}

function wantsHistory(): boolean {
  for (const sub of subscribers.values()) {
    if (sub.history) return true;
  }
  return false;
}

function publish(next: TelemetrySourceState): void {
  state = next;
  for (const sub of [...subscribers.values()]) {
    sub.listener(state);
  }
}

function scheduleNext(): void {
  if (subscribers.size === 0) return;
  if (!isWindowVisible()) return;
  if (timeoutId !== null) return;
  timeoutId = window.setTimeout(() => {
    timeoutId = null;
    void tick();
  }, effectiveIntervalMs());
}

async function tick(): Promise<void> {
  if (subscribers.size === 0) return;
  if (inFlight) return;
  if (!isWindowVisible()) return;
  inFlight = true;
  const readsHistory = wantsHistory();
  try {
    const [snapshot, history] = await Promise.all([
      getFullTelemetrySnapshot(),
      readsHistory ? getRuntimeTelemetryHistory() : Promise.resolve(null),
    ]);
    if (subscribers.size === 0) return;
    publish({
      snapshot,
      history,
      historyReadAtMs: history ? Date.now() : null,
      error: null,
      isLoading: false,
    });
  } catch (raw) {
    if (subscribers.size === 0) return;
    const error = raw instanceof Error ? raw : new Error(parseCommandError(raw).message);
    console.error("[LumaSync] telemetry poll failed:", error);
    publish({ ...state, error, isLoading: false });
  } finally {
    inFlight = false;
    // A history subscriber that joined mid-tick would otherwise open a whole
    // interval after the numbers beside it.
    if (!readsHistory && wantsHistory() && subscribers.size > 0) void tick();
    else scheduleNext();
  }
}

function handleVisibilityChange(visible: boolean): void {
  if (subscribers.size === 0) return;
  if (visible && timeoutId === null && !inFlight) {
    void tick();
  }
}

function teardown(): void {
  if (timeoutId !== null) {
    window.clearTimeout(timeoutId);
    timeoutId = null;
  }
  releaseVisibility?.();
  releaseVisibility = null;
  // Drop the snapshot so a later subscriber never opens on minutes-old data.
  state = INITIAL_STATE;
}

/**
 * Subscribe to the shared loop. The listener fires immediately with the
 * current state, then on every tick. Returns the unsubscribe function; the
 * loop stops once the last subscriber leaves.
 */
export function subscribeTelemetry(
  intervalMs: number,
  listener: TelemetrySourceListener,
  { history = false }: { history?: boolean } = {},
): () => void {
  const key = Symbol("telemetry-subscriber");
  const wasIdle = subscribers.size === 0;
  subscribers.set(key, { intervalMs, listener, history });

  releaseVisibility ??= subscribeWindowVisible(handleVisibilityChange);

  listener(state);

  // A joiner rides the running loop's cadence rather than firing its own
  // round-trip — that duplicate request is the whole bug. Only an idle loop
  // (or one with nothing to show yet) needs an immediate tick.
  if (wasIdle || state.snapshot === null || (history && state.history === null)) {
    void tick();
  } else {
    scheduleNext();
  }

  return () => {
    subscribers.delete(key);
    if (subscribers.size === 0) teardown();
    // Reopening must not draw a history minutes old.
    else if (!wantsHistory()) state = { ...state, history: null, historyReadAtMs: null };
  };
}

/** Test-only: drop all subscribers and reset the loop to a cold state. */
export function __resetTelemetrySourceForTests(): void {
  subscribers.clear();
  inFlight = false;
  teardown();
}
