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
/** The list as drawn: the items, and each leaving one back at the place it was drawn in. */
function merge<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  leaving: ReadonlyMap<string, { item: T; index: number }>,
  openedWith: ReadonlySet<string>,
): ListRow<T>[] {
  const rows: ListRow<T>[] = items.map((item) => {
    const key = keyOf(item);
    return { key, item, leaving: false, arrived: !openedWith.has(key) };
  });
  // In ascending order: each goes back where it stood among the rows placed before it.
  const back = [...leaving].sort(([, a], [, b]) => a.index - b.index);
  for (const [key, { item, index }] of back) {
    rows.splice(Math.min(index, rows.length), 0, { key, item, leaving: true, arrived: false });
  }
  return rows;
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
    // Places are taken from the list as it was drawn, leaving rows included, so two that go a
    // moment apart keep their order.
    const drawn = merge(previous.items, keyOf, leaving, openedWith);
    const next = new Map<string, { item: T; index: number }>();
    drawn.forEach((row, index) => {
      if (!present.has(row.key)) next.set(row.key, { item: row.item, index });
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

  return merge(items, keyOf, leaving, openedWith);
}
