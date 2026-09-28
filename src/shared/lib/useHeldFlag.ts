import { useEffect, useState } from "react";

/** How long a busy face stays up once shown: a failure that answers in a few ms still reads as tried. */
export const BUSY_MIN_MS = 600;

/** `active`, but once it rises it reads true for at least `minMs`, however soon it falls. */
export function useHeldFlag(active: boolean, minMs: number = BUSY_MIN_MS): boolean {
  const [wasActive, setWasActive] = useState(active);
  const [rises, setRises] = useState(0);
  const [holding, setHolding] = useState(false);
  if (active !== wasActive) {
    setWasActive(active);
    if (active) {
      setRises((count) => count + 1);
      setHolding(true);
    }
  }

  useEffect(() => {
    if (rises === 0) return;
    const timer = setTimeout(() => setHolding(false), minMs);
    return () => clearTimeout(timer);
  }, [rises, minMs]);

  return active || holding;
}

/** `value`, frozen while `hold` is true: what was shown stays put through a retry instead of closing and reopening. */
export function useHeldValue<T>(value: T, hold: boolean): T {
  const [kept, setKept] = useState(value);
  if (!hold && !Object.is(kept, value)) setKept(value);
  return hold ? kept : value;
}
