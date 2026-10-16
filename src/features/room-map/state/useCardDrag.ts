import { type PointerEvent as ReactPointerEvent, useEffect, useRef } from "react";

import type { LibraryCard, LibraryDrop } from "../model/libraryDrop";
import { CLICK_SLOP_PX } from "../model/snapGeometry";

export const LIBRARY_DRAG_ATTR = "data-library-drag";

export interface CardDrag {
  /** Starts watching a press on a card; it becomes a drag once it travels past the click slop. */
  onPointerDown: (card: LibraryCard) => (event: ReactPointerEvent<HTMLButtonElement>) => void;
}

/** The card's half of a library drag. It listens on the window: the drawer closes once the drag
 *  starts, and the card goes with it. */
export function useCardDrag(drop: LibraryDrop | undefined, { onStart, onAbandon }: { onStart: () => void; onAbandon: () => void }): CardDrag {
  const stop = useRef<(() => void) | null>(null);
  const handlers = useRef({ onStart, onAbandon });
  handlers.current = { onStart, onAbandon };

  useEffect(() => () => stop.current?.(), []);

  return {
    onPointerDown: (card) => (event) => {
      if (!drop || event.button !== 0) return;
      stop.current?.();
      const id = event.pointerId;
      const from = { x: event.clientX, y: event.clientY };
      let dragging = false;

      const end = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", cancel);
        window.removeEventListener("keydown", key, true);
        document.documentElement.removeAttribute(LIBRARY_DRAG_ATTR);
        stop.current = null;
      };
      // The click a drag ends with lands on whatever is under the pointer: the plan's floor deselects on one.
      const swallowClick = () => {
        const eat = (e: MouseEvent) => {
          e.stopPropagation();
          e.preventDefault();
        };
        window.addEventListener("click", eat, { capture: true, once: true });
        setTimeout(() => window.removeEventListener("click", eat, true), 0);
      };
      const move = (e: PointerEvent) => {
        if (e.pointerId !== id) return;
        if (!dragging) {
          if (Math.hypot(e.clientX - from.x, e.clientY - from.y) < CLICK_SLOP_PX) return;
          dragging = true;
          document.documentElement.setAttribute(LIBRARY_DRAG_ATTR, "");
          handlers.current.onStart();
        }
        drop.hover(card, e.clientX, e.clientY);
      };
      const up = (e: PointerEvent) => {
        if (e.pointerId !== id) return;
        end();
        if (!dragging) return;
        swallowClick();
        if (!drop.land(card, e.clientX, e.clientY)) handlers.current.onAbandon();
      };
      const cancel = () => {
        end();
        if (!dragging) return;
        drop.cancel();
        handlers.current.onAbandon();
      };
      // Capture, ahead of the editor's own Escape, which would clear the selection too.
      const key = (e: KeyboardEvent) => {
        if (e.key !== "Escape" || !dragging) return;
        e.preventDefault();
        e.stopPropagation();
        cancel();
      };

      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", cancel);
      window.addEventListener("keydown", key, true);
      stop.current = cancel;
    },
  };
}
