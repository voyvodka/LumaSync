import { useEffect, useRef } from "react";

import { isClick } from "../../model/snapGeometry";

/** The press has left its spot: from here on it is a drag, not a click. */
export function pastSlop(startX: number, startY: number, x: number, y: number): boolean {
  return !isClick(startX, startY, x, y);
}

/** Still a click: nothing carried yet and the press has not left its spot. Once carried, coming
 *  back near the start keeps following the pointer. */
export function stillAClick(element: Element | null | undefined, startX: number, startY: number, x: number, y: number) {
  return !element?.hasAttribute("data-dragging") && isClick(startX, startY, x, y);
}

/** Marks what is being carried, for the lift the plan's stylesheet draws on `[data-dragging]`. */
export function markDragging(element: Element | null | undefined, on: boolean) {
  element?.toggleAttribute("data-dragging", on);
}

/**
 * Esc while `active()` says a drag is under way calls `cancel`, which puts the piece back. Caught on
 * the window before the editor's own Esc, which would otherwise also drop the selection.
 */
export function useEscapeCancels(active: () => boolean, cancel: () => void) {
  const latest = useRef({ active, cancel });
  latest.current = { active, cancel };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !latest.current.active()) return;
      event.preventDefault();
      event.stopPropagation();
      latest.current.cancel();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
}
