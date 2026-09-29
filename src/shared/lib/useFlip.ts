import { useLayoutEffect, useRef, type RefObject } from "react";

import { prefersReducedMotion } from "./motion";

const DURATION_MS = 220;
/** `--lm-ease-out`: the Web Animations API takes no custom property. */
const EASE_OUT = "cubic-bezier(0.2, 0.8, 0.2, 1)";

interface FlipOptions {
  /**
   * An item that is the same thing as one of the old ones under another id — a suggestion that
   * became a scene — travels from that one's place: new id → old id.
   */
  aliases?: ReadonlyMap<string, string>;
  /** The container's own height follows too, rather than jumping to the new one. */
  resize?: boolean;
}

/**
 * Items that change places slide from where they were to where they are, instead of jumping. Each
 * item under `container` carries `data-flip-id`; `ids` is everything whose order or presence can
 * change. The old places are read while rendering the new order — the DOM still holds the old one
 * then — and each moved item is animated from its offset back to none. An item with no old place
 * is left to its own entrance.
 */
export function useFlip(
  container: RefObject<HTMLElement | null>,
  ids: readonly string[],
  { aliases, resize = false }: FlipOptions = {},
): void {
  const key = ids.join("\n");
  const shown = useRef<string | null>(null);
  const before = useRef<{ places: Map<string, DOMRect>; height: number } | null>(null);
  if (shown.current !== null && shown.current !== key && container.current && !before.current) {
    before.current = {
      places: new Map(
        [...container.current.querySelectorAll<HTMLElement>("[data-flip-id]")].map((node) => [
          node.dataset.flipId!,
          node.getBoundingClientRect(),
        ]),
      ),
      height: container.current.getBoundingClientRect().height,
    };
  }
  useLayoutEffect(() => {
    shown.current = key;
    const was = before.current;
    before.current = null;
    const root = container.current;
    if (!was || !root || prefersReducedMotion()) return;
    const timing = { duration: DURATION_MS, easing: EASE_OUT };
    for (const node of root.querySelectorAll<HTMLElement>("[data-flip-id]")) {
      const id = node.dataset.flipId!;
      const alias = aliases?.get(id);
      const from = was.places.get(id) ?? (alias ? was.places.get(alias) : undefined);
      if (!from) continue;
      const to = node.getBoundingClientRect();
      const dx = from.left - to.left;
      const dy = from.top - to.top;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
      const flight = node.animate?.([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], timing);
      // One that changed identity crosses the others: marked while it does, so it can pass over them.
      if (alias && flight && !was.places.has(id)) {
        node.setAttribute("data-flip-travelling", "");
        const land = () => node.removeAttribute("data-flip-travelling");
        flight.onfinish = land;
        flight.oncancel = land;
      }
    }
    if (resize) {
      const height = root.getBoundingClientRect().height;
      if (Math.abs(height - was.height) >= 0.5) {
        root.animate?.([{ height: `${was.height}px` }, { height: `${height}px` }], timing);
      }
    }
  }, [key, container, aliases, resize]);
}
