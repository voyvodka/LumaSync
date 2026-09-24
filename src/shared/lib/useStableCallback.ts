import { useCallback, useRef, useState } from "react";

// The refs below are written during render, not in an effect: a child's layout
// effect runs before its parent's, and would otherwise call the previous closure.

/**
 * A function whose identity never changes and which always calls the newest
 * `fn`. For a handler handed to a memoised child or put into a context, where
 * a fresh closure per render would re-render every consumer.
 */
export function useStableCallback<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  return useCallback((...args: A) => fnRef.current(...args), []);
}

type Handler = (...args: never[]) => unknown;

/**
 * `useStableCallback` for a bag of handlers: one object, built once, whose
 * members call the newest handler of the same name. The key set is read on
 * the first render only.
 */
export function useStableHandlers<T extends { [K in keyof T]: Handler }>(handlers: T): T {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const [stable] = useState(() => {
    const bag: Record<string, (...args: unknown[]) => unknown> = {};
    for (const key of Object.keys(handlers)) {
      bag[key] = (...args: unknown[]) =>
        (handlersRef.current[key as keyof T] as unknown as (...a: unknown[]) => unknown)(...args);
    }
    return bag as unknown as T;
  });
  return stable;
}
