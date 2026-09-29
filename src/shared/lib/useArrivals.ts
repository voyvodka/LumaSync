import { useCallback, useLayoutEffect, useRef, useState } from "react";

/**
 * Ids that appeared since the last render — a scene just saved or added — held until `settled`
 * says its entrance ended, so a re-render in between (the write landing) does not cut it short.
 * None on the first render: what is there when the list opens does not arrive.
 */
export function useArrivals(ids: readonly string[]): { arrived: ReadonlySet<string>; settled: (id: string) => void } {
  const seen = useRef<Set<string> | null>(null);
  const [arrived, setArrived] = useState<ReadonlySet<string>>(new Set());
  const key = ids.join("\n");
  useLayoutEffect(() => {
    const now = key === "" ? [] : key.split("\n");
    const fresh = seen.current ? now.filter((id) => !seen.current!.has(id)) : [];
    seen.current = new Set(now);
    if (fresh.length > 0) setArrived((current) => new Set([...current, ...fresh]));
  }, [key]);
  const settled = useCallback((id: string) => {
    setArrived((current) => {
      if (!current.has(id)) return current;
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  }, []);
  return { arrived, settled };
}
