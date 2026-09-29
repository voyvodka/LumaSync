import { useLayoutEffect, useRef, type RefObject } from "react";

import { prefersReducedMotion } from "./motion";

const DURATION_MS = 220;
/** `--lm-ease-out`: the Web Animations API takes no custom property. */
const EASE_OUT = "cubic-bezier(0.2, 0.8, 0.2, 1)";

/**
 * Items that change places slide from where they were to where they are, instead of jumping. Each
 * item under `container` carries `data-flip-id`; `ids` is their order. The old places are read
 * while rendering the new order — the DOM still holds the old one then — and each moved item is
 * animated from its offset back to none. An item that is new has no old place and is left to its
 * own entrance.
 */
export function useFlip(container: RefObject<HTMLElement | null>, ids: readonly string[]): void {
  const key = ids.join("\n");
  const shown = useRef<string | null>(null);
  const before = useRef<Map<string, DOMRect> | null>(null);
  if (shown.current !== null && shown.current !== key && container.current && !before.current) {
    before.current = new Map(
      [...container.current.querySelectorAll<HTMLElement>("[data-flip-id]")].map((node) => [
        node.dataset.flipId!,
        node.getBoundingClientRect(),
      ]),
    );
  }
  useLayoutEffect(() => {
    shown.current = key;
    const was = before.current;
    before.current = null;
    if (!was || !container.current || prefersReducedMotion()) return;
    for (const node of container.current.querySelectorAll<HTMLElement>("[data-flip-id]")) {
      const from = was.get(node.dataset.flipId!);
      if (!from) continue;
      const to = node.getBoundingClientRect();
      const dx = from.left - to.left;
      const dy = from.top - to.top;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
      node.animate?.([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], {
        duration: DURATION_MS,
        easing: EASE_OUT,
      });
    }
  }, [key, container]);
}
