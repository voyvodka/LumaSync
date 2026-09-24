/**
 * This window's copy of the Rust health monitor's `HueHealthSnapshot`, as an
 * external store. Seeded by `watch_hue_health`, kept by `hue://health`, older
 * revisions dropped. It never polls: it tells Rust whether this window is
 * visible and whether a view shows the area, and Rust decides what to read.
 * See docs/architecture/hue.md, "One health monitor".
 */

import type { HueHealthSnapshot, HueHealthWatch } from "@/shared/contracts/hueHealth";
import { parseCommandError } from "@/shared/contracts/status";

import { getHueHealth, listenHueHealth, retryHueHealth, watchHueHealth } from "../hueHealthApi";
import {
  HUE_ONBOARDING_TRANSPORT_CODES as CODE,
  type HueRuntimeStatusReadFailure,
} from "../model/onboardingStatusCodes";
import { runtimeStatusRetryDelayMs } from "../model/pollingCadence";

export interface HueHealthState {
  /** What Rust last published, or `null` until the first answer. */
  snapshot: HueHealthSnapshot | null;
  /** The latest read rejected, so `snapshot` may be stale. Held beside it,
   * never in its place: the rejection says nothing about the runtime. */
  readFailure: HueRuntimeStatusReadFailure | null;
}

const INITIAL: HueHealthState = { snapshot: null, readFailure: null };

let state: HueHealthState = INITIAL;
const listeners = new Set<() => void>();
let areaWatchers = 0;
/** Bumped on every start and stop, so an answer from a torn-down session is dropped. */
let session = 0;
let unlisten: (() => void) | null = null;
let readFailures = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

function notify(): void {
  for (const listener of [...listeners]) listener();
}

function clearRetry(): void {
  if (retryTimer !== null) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
}

function adopt(snapshot: HueHealthSnapshot): void {
  // Only a snapshot carries a revision; anything else is not an answer to keep.
  if (typeof snapshot?.revision !== "number") return;
  const newer = state.snapshot === null || snapshot.revision > state.snapshot.revision;
  if (!newer && state.readFailure === null) return;
  readFailures = 0;
  clearRetry();
  state = { snapshot: newer ? snapshot : state.snapshot, readFailure: null };
  notify();
}

// A rejected read keeps asking whatever the runtime last said — the read
// failing says nothing about it — on the 2, 4, 8, 16, then 30 s backoff.
function noteReadFailure(error: unknown, again: () => void): void {
  readFailures += 1;
  const details = parseCommandError(error).message;
  if (readFailures === 1) {
    console.warn(`[LumaSync] Hue health read failed: ${details}`);
  }
  state = {
    ...state,
    readFailure: {
      code: CODE.STREAM_STATUS_UNAVAILABLE,
      message: "Could not fetch Hue runtime status.",
      details,
    },
  };
  notify();
  clearRetry();
  retryTimer = setTimeout(() => {
    retryTimer = null;
    again();
  }, runtimeStatusRetryDelayMs(readFailures));
}

function isVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

function currentWatch(): HueHealthWatch {
  const visible = isVisible();
  return { visible, areaReadiness: visible && areaWatchers > 0 };
}

function declare(): void {
  if (listeners.size === 0) return;
  const mine = session;
  watchHueHealth(currentWatch())
    .then((snapshot) => {
      if (mine === session) adopt(snapshot);
    })
    .catch((error: unknown) => {
      if (mine === session) noteReadFailure(error, declare);
    });
}

function start(): void {
  session += 1;
  const mine = session;
  listenHueHealth((snapshot) => {
    if (mine === session) adopt(snapshot);
  })
    .then((fn) => {
      if (mine === session) unlisten = fn;
      else fn();
    })
    .catch((error: unknown) => {
      console.error("[LumaSync] Hue health listen failed:", error);
    });
  document.addEventListener("visibilitychange", declare);
  // After the listener is requested, so a publish between the two is not
  // lost: the revision check drops whichever of the two is older.
  declare();
}

function stop(): void {
  session += 1;
  unlisten?.();
  unlisten = null;
  document.removeEventListener("visibilitychange", declare);
  clearRetry();
  readFailures = 0;
  // Nothing here needs the monitor any more; without this it would keep
  // reading the bridge for a window that stopped listening.
  watchHueHealth({ visible: false, areaReadiness: false }).catch((error: unknown) => {
    console.warn("[LumaSync] Hue health release failed:", parseCommandError(error).message);
  });
  // A later subscriber must not open on a snapshot no event has kept current.
  state = INITIAL;
}

/** `useSyncExternalStore`'s subscribe. The first subscriber starts the
 * session, the last one ends it. */
export function subscribeHueHealth(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) start();
  return () => {
    if (!listeners.delete(listener)) return;
    if (listeners.size === 0) stop();
  };
}

export function getHueHealthState(): HueHealthState {
  return state;
}

/** Declares a view that shows the area's readiness, for as long as it is
 * mounted. Returns the release. */
export function watchHueAreaReadiness(): () => void {
  areaWatchers += 1;
  if (areaWatchers === 1) declare();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    areaWatchers -= 1;
    if (areaWatchers === 0) declare();
  };
}

/** A fresh local read, for a caller that just started or stopped the stream
 * itself and must not render the state it changed away from. */
export async function refreshHueHealth(): Promise<void> {
  const mine = session;
  try {
    const snapshot = await getHueHealth();
    if (mine === session) adopt(snapshot);
  } catch (error) {
    if (mine === session) noteReadFailure(error, declare);
  }
}

/** The manual retry behind the "check again" control. */
export function retryHueHealthProbe(): void {
  const mine = session;
  retryHueHealth()
    .then((snapshot) => {
      if (mine === session) adopt(snapshot);
    })
    .catch((error: unknown) => {
      if (mine === session) noteReadFailure(error, declare);
    });
}

/** Test-only: drop every subscriber and go back to a cold store. */
export function __resetHueHealthStoreForTests(): void {
  listeners.clear();
  areaWatchers = 0;
  session += 1;
  unlisten?.();
  unlisten = null;
  document.removeEventListener("visibilitychange", declare);
  clearRetry();
  readFailures = 0;
  state = INITIAL;
}
