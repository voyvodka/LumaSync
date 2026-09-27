import { useEffect, useState } from "react";

/** Longer than the house close (Reveal's 0.22 s), so a leaving row finishes before it is dropped. */
const LEAVE_MS = 400;

export interface ListRow<T> {
  key: string;
  item: T;
  /** Gone from the list, closing where it stood. */
  leaving: boolean;
  /** Arrived after the list first showed; what the page opened on is already in place. */
  arrived: boolean;
}

/**
 * The rows of a list that changes under the user — a port plugged in, a bridge found — with the
 * ones that just left kept in place, closing, for as long as their exit takes: a row removed from
 * an array would otherwise vanish in one frame.
 */
export function useLeavingItems<T>(items: readonly T[], keyOf: (item: T) => string): ListRow<T>[] {
  const signature = items.map(keyOf).join("\u0000");
  const [previous, setPrevious] = useState<{ signature: string; items: readonly T[] }>({ signature, items });
  const [leaving, setLeaving] = useState<ReadonlyMap<string, { item: T; index: number }>>(new Map());
  const [openedWith, setOpenedWith] = useState<ReadonlySet<string>>(() => new Set(items.map(keyOf)));

  // Keyed on the keys, not the array: a caller's fresh array each render must not look like a change.
  if (previous.signature !== signature) {
    const present = new Set(items.map(keyOf));
    const next = new Map([...leaving].filter(([key]) => !present.has(key)));
    previous.items.forEach((item, index) => {
      const key = keyOf(item);
      if (!present.has(key)) next.set(key, { item, index });
    });
    setPrevious({ signature, items });
    setLeaving(next);
    // A row that left and comes back arrives like any other.
    setOpenedWith(new Set([...openedWith].filter((key) => present.has(key))));
  }

  useEffect(() => {
    if (leaving.size === 0) return;
    const timer = setTimeout(() => setLeaving(new Map()), LEAVE_MS);
    return () => clearTimeout(timer);
  }, [leaving]);

  const rows: ListRow<T>[] = items.map((item) => {
    const key = keyOf(item);
    return { key, item, leaving: false, arrived: !openedWith.has(key) };
  });
  for (const [key, { item, index }] of leaving) {
    rows.splice(Math.min(index, rows.length), 0, { key, item, leaving: true, arrived: false });
  }
  return rows;
}
