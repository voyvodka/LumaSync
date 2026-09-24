import { useCallback, useRef, useSyncExternalStore } from "react";

import type { HueRuntimeState } from "@/shared/contracts/hue";
import type { HueAreaHealth, HueBridgeHealth } from "@/shared/contracts/hueHealth";

import type {
  HueRuntimeStatusReadFailure,
  HueRuntimeStatusView,
} from "../model/onboardingStatusCodes";
import { getHueHealthState, subscribeHueHealth, type HueHealthState } from "./hueHealthStore";

/**
 * The one Hue health hook. `selector` picks a slice of the snapshot and the
 * component re-renders only when that slice changes by `isEqual` — every event
 * parses a fresh object, so an object slice needs a structural comparison.
 */
export function useHueHealth<T>(
  selector: (state: HueHealthState) => T,
  isEqual: (a: T, b: T) => boolean = Object.is,
): T {
  const cache = useRef<{ state: HueHealthState; selected: T } | null>(null);
  const getSelection = useCallback(() => {
    const current = getHueHealthState();
    const held = cache.current;
    if (held && held.state === current) return held.selected;
    const next = selector(current);
    if (held && isEqual(held.selected, next)) {
      cache.current = { state: current, selected: held.selected };
      return held.selected;
    }
    cache.current = { state: current, selected: next };
    return next;
  }, [selector, isEqual]);
  return useSyncExternalStore(subscribeHueHealth, getSelection, getSelection);
}

export const selectHueStreamState = (state: HueHealthState): HueRuntimeState | null =>
  state.snapshot?.stream?.status?.state ?? null;

export const selectHueRuntimeStatus = (state: HueHealthState): HueRuntimeStatusView | null =>
  state.snapshot?.stream?.status ?? null;

export const selectHueReadFailure = (state: HueHealthState): HueRuntimeStatusReadFailure | null =>
  state.readFailure;

export const selectHueBridgeHealth = (state: HueHealthState): HueBridgeHealth | null =>
  state.snapshot?.bridge ?? null;

export const selectHueAreaHealth = (state: HueHealthState): HueAreaHealth | null =>
  state.snapshot?.area ?? null;

/** Structural equality for the small JSON slices the selectors return. */
export function sameJson<T>(a: T, b: T): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}
