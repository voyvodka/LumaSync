import { useCallback, useState } from "react";

/** Lives as long as the webview: a restart starts clean, which is the point. */
const memory = new Map<string, unknown>();

/**
 * `useState` that a remount picks up where it left off — a page of a section the user switched away
 * from and back to. Nothing is saved to disk.
 */
export function useSessionState<T>(key: string, initial: T | (() => T)): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(() => {
    if (memory.has(key)) return memory.get(key) as T;
    return typeof initial === "function" ? (initial as () => T)() : initial;
  });
  const set = useCallback(
    (next: T) => {
      memory.set(key, next);
      setValue(next);
    },
    [key],
  );
  return [value, set];
}

export function peekSessionState<T>(key: string): T | undefined {
  return memory.get(key) as T | undefined;
}

/** Test-only. */
export function __resetSessionStateForTests(): void {
  memory.clear();
}
