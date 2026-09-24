/**
 * This window's copy of the Rust health monitor's `HueHealthSnapshot`, as a
 * `Store` (`shared/lib/store.ts`). Seeded by `watch_hue_health`, kept by
 * `hue://health`, older revisions dropped. It never polls: it tells Rust
 * whether this window is visible and whether a view shows the area, and Rust
 * decides what to read. See docs/architecture/hue.md, "One health monitor".
 */

import { isWindowVisible, subscribeWindowVisible } from "@/features/shell/windowVisibility";
import type { HueHealthSnapshot, HueHealthWatch } from "@/shared/contracts/hueHealth";
import type { Store } from "@/shared/lib/store";
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

// A `Store` by hand rather than `createStore`: going back to INITIAL when the
// last subscriber leaves must not notify, or a test reset re-renders trees
// outside `act` and an unmounting tree renders on the way out.
let state: HueHealthState = INITIAL;
const listeners = new Set<() => void>();
const cell = {
  get: (): HueHealthState => state,
  set: (next: HueHealthState): void => {
    if (Object.is(next, state)) return;
    state = next;
    for (const listener of [...listeners]) listener();
  },
  subscribe: (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

function resetQuietly(): void {
  state = INITIAL;
}
let subscribers = 0;
/** Bumped by the test reset, so a subscription from before it releases nothing after it. */
let generation = 0;
let areaWatchers = 0;
/** Bumped on every start and stop, so an answer from a torn-down session is dropped. */
let session = 0;
let unlisten: (() => void) | null = null;
let releaseVisibility: (() => void) | null = null;
let readFailures = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

function clearRetry(): void {
  if (retryTimer !== null) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
}

function adopt(snapshot: HueHealthSnapshot): void {
  // Only a snapshot carries a revision; anything else is not an answer to keep.
  if (typeof snapshot?.revision !== "number") return;
  const state = cell.get();
  const newer = state.snapshot === null || snapshot.revision > state.snapshot.revision;
  if (!newer && state.readFailure === null) return;
  readFailures = 0;
  clearRetry();
  cell.set({ snapshot: newer ? snapshot : state.snapshot, readFailure: null });
}

// A rejected read keeps asking whatever the runtime last said — the read
// failing says nothing about it — on the 2, 4, 8, 16, then 30 s backoff.
function noteReadFailure(error: unknown, again: () => void): void {
  readFailures += 1;
  const details = parseCommandError(error).message;
  if (readFailures === 1) {
    console.warn(`[LumaSync] Hue health read failed: ${details}`);
  }
  cell.set({
    ...cell.get(),
    readFailure: {
      code: CODE.STREAM_STATUS_UNAVAILABLE,
      message: "Could not fetch Hue runtime status.",
      details,
    },
  });
  clearRetry();
  retryTimer = setTimeout(() => {
    retryTimer = null;
    again();
  }, runtimeStatusRetryDelayMs(readFailures));
}

// The area flag is sent as is, hidden or not: Rust reads the area only while
// the window is visible, and tells a view mounting from a window showing by it.
// Visible is the document *and* Rust's read of the native window: WebView2 can
// report a window hidden in the tray as visible (ui-and-shell.md).
function currentWatch(): HueHealthWatch {
  return { visible: isWindowVisible(), areaReadiness: areaWatchers > 0 };
}

function declare(): void {
  if (subscribers === 0) return;
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
  releaseVisibility = subscribeWindowVisible(() => declare());
  // After the listener is requested, so a publish between the two is not
  // lost: the revision check drops whichever of the two is older.
  declare();
}

function stop(): void {
  session += 1;
  unlisten?.();
  unlisten = null;
  releaseVisibility?.();
  releaseVisibility = null;
  clearRetry();
  readFailures = 0;
  // Nothing here needs the monitor any more; without this it would keep
  // reading the bridge for a window that stopped listening.
  watchHueHealth({ visible: false, areaReadiness: false }).catch((error: unknown) => {
    console.warn("[LumaSync] Hue health release failed:", parseCommandError(error).message);
  });
  // A later subscriber must not open on a snapshot no event has kept current.
  resetQuietly();
}

/**
 * The store `useHueHealth` selects from. The first subscriber starts the
 * session — listen, then declare this window — and the last one ends it.
 */
export const hueHealthStore: Store<HueHealthState> = {
  get: cell.get,
  set: cell.set,
  subscribe: (listener) => {
    const unsubscribe = cell.subscribe(listener);
    const mine = generation;
    subscribers += 1;
    if (subscribers === 1) start();
    let released = false;
    return () => {
      unsubscribe();
      if (released || mine !== generation) return;
      released = true;
      subscribers -= 1;
      if (subscribers === 0) stop();
    };
  },
};

export const subscribeHueHealth = hueHealthStore.subscribe;

export function getHueHealthState(): HueHealthState {
  return cell.get();
}

/** Declares a view that shows the area's readiness, for as long as it is
 * mounted. Returns the release. */
export function watchHueAreaReadiness(): () => void {
  areaWatchers += 1;
  if (areaWatchers === 1) declare();
  const mine = generation;
  let released = false;
  return () => {
    if (released || mine !== generation) return;
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
  generation += 1;
  subscribers = 0;
  areaWatchers = 0;
  session += 1;
  unlisten?.();
  unlisten = null;
  releaseVisibility?.();
  releaseVisibility = null;
  clearRetry();
  readFailures = 0;
  listeners.clear();
  resetQuietly();
}
