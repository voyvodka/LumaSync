import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";

/**
 * A value outside React that components subscribe to through a selector. A
 * consumer re-renders only when its selection changes, which a context value
 * cannot give: every consumer of a context re-renders on every new value.
 * See docs/architecture/ui-and-shell.md, "Shell state reaches sections through stores".
 */
export interface Store<T> {
  get: () => T;
  /** Notifies subscribers unless `next` is the value already held. */
  set: (next: T) => void;
  subscribe: (listener: () => void) => () => void;
}

export function createStore<T>(initial: T): Store<T> {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set: (next) => {
      if (Object.is(next, state)) return;
      state = next;
      for (const listener of [...listeners]) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** One level deep: two objects with the same keys holding `Object.is`-equal values. */
export function shallowEqual<T>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  return aKeys.every(
    (key) =>
      Object.prototype.hasOwnProperty.call(b, key) &&
      Object.is((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
  );
}

interface SelectionCache<T, S> {
  state: T;
  selector: (state: T) => S;
  selection: S;
}

/**
 * The slice of `store` that `selector` picks. An equal selection keeps the
 * previous one's identity, so an object-returning selector with `shallowEqual`
 * does not re-render its consumer when the store moved elsewhere.
 */
export function useStoreSelector<T, S>(
  store: Store<T>,
  selector: (state: T) => S,
  isEqual: (a: S, b: S) => boolean = Object.is,
): S {
  const cacheRef = useRef<SelectionCache<T, S> | null>(null);
  const getSelection = (): S => {
    const state = store.get();
    const cache = cacheRef.current;
    if (cache !== null && cache.state === state && cache.selector === selector) return cache.selection;
    const next = selector(state);
    const selection = cache !== null && isEqual(cache.selection, next) ? cache.selection : next;
    cacheRef.current = { state, selector, selection };
    return selection;
  };
  return useSyncExternalStore(store.subscribe, getSelection, getSelection);
}

/**
 * A store that follows `value`, for state a hook owns but its subscribers sit
 * below a memo boundary. Seeded with the first render's value, so nothing
 * mounts on a placeholder; later values land in a layout effect, and the
 * subscribers that care re-render before the browser paints.
 */
export function useMirroredStore<T>(value: T, isEqual: (a: T, b: T) => boolean = shallowEqual): Store<T> {
  const [store] = useState(() => createStore(value));
  useLayoutEffect(() => {
    if (!isEqual(store.get(), value)) store.set(value);
  });
  return store;
}
