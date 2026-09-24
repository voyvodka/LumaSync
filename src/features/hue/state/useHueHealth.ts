import type { HueRuntimeState } from "@/shared/contracts/hue";
import type { HueAreaHealth, HueBridgeHealth } from "@/shared/contracts/hueHealth";
import { useStoreSelector } from "@/shared/lib/store";

import type {
  HueRuntimeStatusReadFailure,
  HueRuntimeStatusView,
} from "../model/onboardingStatusCodes";
import { hueHealthStore, type HueHealthState } from "./hueHealthStore";

/**
 * The one Hue health hook. `selector` picks a slice of the snapshot and the
 * component re-renders only when that slice changes by `isEqual` — every event
 * parses a fresh object, so an object slice needs a structural comparison.
 * Selectors must be stable (module-level): a new one per render re-selects.
 */
export function useHueHealth<T>(
  selector: (state: HueHealthState) => T,
  isEqual: (a: T, b: T) => boolean = Object.is,
): T {
  return useStoreSelector(hueHealthStore, selector, isEqual);
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
