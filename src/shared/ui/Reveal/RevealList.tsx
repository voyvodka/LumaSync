import type { ReactNode } from "react";

import { Reveal } from "./Reveal";
import { useLeavingItems } from "./useLeavingItems";

interface RevealListProps<T> {
  items: readonly T[];
  keyOf: (item: T) => string;
  children: (item: T) => ReactNode;
}

/**
 * Rows that come and go with a list — a port plugged in, a bridge found. One that arrives grows in;
 * one that leaves closes where it stood.
 */
export function RevealList<T>({ items, keyOf, children }: RevealListProps<T>) {
  return (
    <>
      {useLeavingItems(items, keyOf).map((row) => (
        <Reveal key={row.key} open={!row.leaving} appear={row.arrived}>
          {children(row.item)}
        </Reveal>
      ))}
    </>
  );
}
