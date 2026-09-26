/**
 * View preferences kept in `ShellState`: one store for all of them, read once per window and kept
 * in step with every window's writes, so a change applies everywhere with no restart. Adding one is
 * a row in `PREFERENCES`.
 *
 * Each is a flat top-level key: a save replaces a top-level key whole, so two windows writing
 * different parts of one nested object would overwrite each other. Absent or unrecognised reads
 * as the row's default, which is why none of them is in `DEFAULT_SHELL_STATE`.
 */

import { useEffect } from "react";

import { shellStore } from "@/features/persistence/shellStore";
import { APP_VERSION } from "@/shared/constants/app";
import {
  resolveCloseAction,
  resolveLaunchLights,
  resolveMotionPreference,
  resolveNotificationsPreference,
  resolveUiZoom,
  resolveUpdateChannel,
  type ShellState,
} from "@/shared/contracts/shell";
import { createStore, useStoreSelector } from "@/shared/lib/store";

const PREFERENCES = {
  showNerdStats: (stored: unknown): boolean => stored === true,
  motion: resolveMotionPreference,
  updateChannel: (stored: unknown) => resolveUpdateChannel(stored, APP_VERSION),
  uiZoom: resolveUiZoom,
  closeAction: resolveCloseAction,
  notifications: resolveNotificationsPreference,
  launchLights: resolveLaunchLights,
} satisfies { [K in keyof ShellState]?: (stored: unknown) => NonNullable<ShellState[K]> };

export type PreferenceKey = keyof typeof PREFERENCES;

/**
 * Rust reads these off disk to decide something (the update feed, the webview zoom, what the close
 * button does, notifications, the launch restore). A failed save reverts them: showing a choice
 * Rust never saw would say one thing while the app did another.
 */
const READ_BY_RUST: ReadonlySet<PreferenceKey> = new Set<PreferenceKey>([
  "updateChannel",
  "uiZoom",
  "closeAction",
  "notifications",
  "launchLights",
]);
export type PreferenceValue<K extends PreferenceKey> = ReturnType<(typeof PREFERENCES)[K]>;
type Preferences = { [K in PreferenceKey]: PreferenceValue<K> };

const KEYS = Object.keys(PREFERENCES) as PreferenceKey[];
const hasOwn = (state: Partial<ShellState>, key: PreferenceKey) => Object.prototype.hasOwnProperty.call(state, key);

function resolve<K extends PreferenceKey>(key: K, stored: unknown): PreferenceValue<K> {
  return PREFERENCES[key](stored) as PreferenceValue<K>;
}

function defaults(): Preferences {
  return Object.fromEntries(KEYS.map((key) => [key, resolve(key, undefined)])) as Preferences;
}

const store = createStore<Preferences>(defaults());

let hydrated = false;
/** A choice made before the persisted value arrived wins over it, per key. */
const chosenBeforeLoad = new Set<PreferenceKey>();
let stopFollowingSaves: (() => void) | null = null;

function merge(state: Partial<ShellState>, skip: ReadonlySet<PreferenceKey>): void {
  const next = { ...store.get() };
  let changed = false;
  for (const key of KEYS) {
    if (skip.has(key) || !hasOwn(state, key)) continue;
    const value = resolve(key, state[key]);
    if (!Object.is(next[key], value)) {
      (next as Record<PreferenceKey, unknown>)[key] = value;
      changed = true;
    }
  }
  if (changed) store.set(next);
}

/**
 * Starts following the persisted preferences. `loaded` is a state this window already read at
 * boot, so no second read is made for it.
 */
export function hydratePreferences(loaded?: Partial<ShellState>): void {
  if (hydrated) return;
  hydrated = true;

  // Another window's write, or this one's own echo; a removed key arrives as its own `undefined`.
  stopFollowingSaves = shellStore.onSaved((saved) => merge(saved, new Set()));

  const apply = (state: Partial<ShellState>) => merge({ ...defaults(), ...state }, chosenBeforeLoad);
  if (loaded) {
    apply(loaded);
    return;
  }
  shellStore
    .load()
    .then(apply)
    .catch((err: unknown) => {
      console.error("[LumaSync] loading preferences failed:", err);
    });
}

export function usePreference<K extends PreferenceKey>(key: K): PreferenceValue<K> {
  useEffect(() => {
    hydratePreferences();
  }, []);
  return useStoreSelector(store, (prefs) => prefs[key]) as PreferenceValue<K>;
}

export function getPreference<K extends PreferenceKey>(key: K): PreferenceValue<K> {
  return store.get()[key] as PreferenceValue<K>;
}

/** Calls `listener` whenever `key` changes, outside React. */
export function followPreference<K extends PreferenceKey>(key: K, listener: (value: PreferenceValue<K>) => void): () => void {
  let last = getPreference(key);
  return store.subscribe(() => {
    const value = getPreference(key);
    if (Object.is(value, last)) return;
    last = value;
    listener(value);
  });
}

/**
 * Applies at once. A view preference holds for the session even when the save fails: the shell's
 * "settings can't be saved" notice says a change lasts until quit, and a switch that snapped back
 * would contradict it. One Rust reads off disk (`READ_BY_RUST`) reverts instead, since showing a
 * choice that was never stored would lie.
 */
export async function setPreference<K extends PreferenceKey>(
  key: K,
  value: PreferenceValue<K>,
  { revertOnFailure = READ_BY_RUST.has(key) }: { revertOnFailure?: boolean } = {},
): Promise<void> {
  const previous = getPreference(key);
  chosenBeforeLoad.add(key);
  store.set({ ...store.get(), [key]: value });
  try {
    await shellStore.save({ [key]: value } as Partial<ShellState>);
  } catch (err) {
    console.error(`[LumaSync] shellStore.save(${key}) failed:`, err);
    if (revertOnFailure) store.set({ ...store.get(), [key]: previous });
  }
}

/** Test-only: seed a value without touching the persisted state. */
export function __setPreferenceForTests<K extends PreferenceKey>(key: K, value: PreferenceValue<K>): void {
  hydrated = true;
  chosenBeforeLoad.add(key);
  store.set({ ...store.get(), [key]: value });
}

/** Test-only: back to cold, unhydrated defaults. */
export function __resetPreferencesForTests(): void {
  stopFollowingSaves?.();
  stopFollowingSaves = null;
  hydrated = false;
  chosenBeforeLoad.clear();
  store.set(defaults());
}
