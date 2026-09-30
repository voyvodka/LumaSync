import { useLayoutEffect, useRef, type RefObject } from "react";

import { prefersReducedMotion } from "./motion";

const DURATION_MS = 220;
/** A gone item's fade: shorter than the slide, so it has left before the others settle over it. */
const EXIT_MS = 160;
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
  /**
   * An item that is gone fades out where it stood instead of vanishing: a copy of it — a ghost,
   * inert and unnamed — over the others as they slide. The container must be positioned; the ghost
   * is its last child for the fade, so a `:last-child` rule on the items sees it meanwhile.
   */
  exits?: boolean;
}

/**
 * Items that change places slide from where they were to where they are, instead of jumping. Each
 * item under `container` carries `data-flip-id`; `ids` is everything whose order or presence can
 * change. The old places are read while rendering the new order — the DOM still holds the old one
 * then — and each moved item is animated from its offset back to none. An item with no old place
 * is left to its own entrance.
 */
const aliasSources = (aliases: ReadonlyMap<string, string> | undefined): ReadonlySet<string> =>
  new Set(aliases ? aliases.values() : []);

export function useFlip(
  container: RefObject<HTMLElement | null>,
  ids: readonly string[],
  { aliases, resize = false, exits = false }: FlipOptions = {},
): void {
  const key = ids.join("\n");
  const shown = useRef<string | null>(null);
  const before = useRef<{ places: Map<string, DOMRect>; height: number; copies: Map<string, HTMLElement> } | null>(
    null,
  );
  // A render back to the order on screen (one that was thrown away, or undone) drops the old places.
  if (shown.current === key) before.current = null;
  if (shown.current !== null && shown.current !== key && container.current && !before.current) {
    const nodes = [...container.current.querySelectorAll<HTMLElement>("[data-flip-id]")];
    before.current = {
      places: new Map(nodes.map((node) => [node.dataset.flipId!, node.getBoundingClientRect()])),
      height: container.current.getBoundingClientRect().height,
      // Copied now: by the layout effect React has already taken the gone ones out. Only those
      // going — the ids rendered next are known here — and never an alias's source, which travels.
      copies: new Map(
        exits && !prefersReducedMotion()
          ? nodes
              .filter((node) => !ids.includes(node.dataset.flipId!) && !aliasSources(aliases).has(node.dataset.flipId!))
              .map((node) => [node.dataset.flipId!, node.cloneNode(true) as HTMLElement])
          : [],
      ),
    };
  }
  useLayoutEffect(() => {
    shown.current = key;
    const was = before.current;
    before.current = null;
    const root = container.current;
    if (!was || !root || prefersReducedMotion()) return;
    const timing = { duration: DURATION_MS, easing: EASE_OUT };
    const present = new Set([...root.querySelectorAll<HTMLElement>("[data-flip-id]")].map((node) => node.dataset.flipId!));
    // Positions inside the container's padding box, scrolled content included.
    const rootBox = root.getBoundingClientRect();
    const box = {
      left: rootBox.left + root.clientLeft - root.scrollLeft,
      top: rootBox.top + root.clientTop - root.scrollTop,
    };
    for (const [id, ghost] of was.copies) {
      if (present.has(id)) continue;
      const from = was.places.get(id)!;
      ghost.removeAttribute("data-flip-id");
      ghost.removeAttribute("data-entering");
      // Nothing in it may be found in its place: no ids, no test ids.
      for (const node of [ghost, ...ghost.querySelectorAll<HTMLElement>("[id], [data-testid]")]) {
        node.removeAttribute("id");
        node.removeAttribute("data-testid");
      }
      ghost.setAttribute("aria-hidden", "true");
      ghost.setAttribute("inert", "");
      Object.assign(ghost.style, {
        position: "absolute",
        left: `${from.left - box.left}px`,
        top: `${from.top - box.top}px`,
        width: `${from.width}px`,
        height: `${from.height}px`,
        margin: "0",
        pointerEvents: "none",
      });
      root.appendChild(ghost);
      ghost.animate?.([{ opacity: 1 }, { opacity: 0 }], { duration: EXIT_MS, easing: "linear", fill: "forwards" });
      // A timer, not `onfinish`: a webview that never finishes the fade must still lose the ghost.
      setTimeout(() => ghost.remove(), EXIT_MS);
    }
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
