import { useEffect, useRef, useState } from "react";

import { useStableCallback } from "./useStableCallback";

export interface ThrottledCommit<T> {
  /** Commits at once when `intervalMs` has passed since the last commit, else once it has. */
  push: (value: T) => void;
  /** Commits the latest value now, pending or not — a drag's release. */
  flush: () => void;
  /** Records the value an outside change settled on, so a later `flush` does not revert it. */
  sync: (value: T) => void;
  /** A pushed value is waiting for its trailing commit. */
  isPending: () => boolean;
}

/**
 * Leading-and-trailing throttle for a control that commits while it moves — a
 * slider or colour drag that must neither flood the lighting runtime nor drop
 * the value the user let go on. The pending timer dies with the component.
 */
export function useThrottledCommit<T>(
  onCommit: (value: T) => void,
  intervalMs: number,
): ThrottledCommit<T> {
  const commit = useStableCallback(onCommit);
  const state = useRef<{ latest: { value: T } | null; timer: number | null; lastAt: number }>({
    latest: null,
    timer: null,
    lastAt: 0,
  });

  useEffect(
    () => () => {
      const { timer } = state.current;
      if (timer !== null) window.clearTimeout(timer);
    },
    [],
  );

  const [api] = useState<ThrottledCommit<T>>(() => {
    const clearTimer = () => {
      const current = state.current;
      if (current.timer !== null) {
        window.clearTimeout(current.timer);
        current.timer = null;
      }
    };
    const flush = () => {
      clearTimer();
      const current = state.current;
      current.lastAt = Date.now();
      if (current.latest) commit(current.latest.value);
    };
    return {
      push: (value) => {
        const current = state.current;
        current.latest = { value };
        clearTimer();
        const waitMs = Math.max(0, intervalMs - (Date.now() - current.lastAt));
        if (waitMs === 0) flush();
        else current.timer = window.setTimeout(flush, waitMs);
      },
      flush,
      sync: (value) => {
        state.current.latest = { value };
      },
      isPending: () => state.current.timer !== null,
    };
  });

  return api;
}
