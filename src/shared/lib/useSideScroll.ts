import { useEffect, useState, type RefObject } from "react";

import { prefersReducedMotion } from "./motion";

/** Which edges of a sideways list have more past them. */
export type SideMore = "start" | "end" | "both" | undefined;

/**
 * A one-line list that scrolls sideways: which edges have more past them (a caller fades those), a
 * vertical wheel turned into a sideways scroll while it overflows, and the chosen item brought into
 * view. `key` changes when the items do; `activeSelector` finds the chosen one inside the list.
 */
export function useSideScroll(
  listRef: RefObject<HTMLElement | null>,
  key: string,
  activeSelector: string | undefined,
): SideMore {
  const [more, setMore] = useState<SideMore>(undefined);
  useEffect(() => {
    const list = listRef.current;
    // No items: nothing scrolls. A new set of items measures afresh.
    if (!list || key === "") return;
    const measure = () => {
      const start = list.scrollLeft > 1;
      const end = list.scrollLeft + list.clientWidth < list.scrollWidth - 1;
      setMore(start && end ? "both" : start ? "start" : end ? "end" : undefined);
    };
    const onWheel = (event: WheelEvent) => {
      if (list.scrollWidth <= list.clientWidth || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      event.preventDefault();
      list.scrollLeft += event.deltaY;
    };
    measure();
    list.addEventListener("scroll", measure, { passive: true });
    list.addEventListener("wheel", onWheel, { passive: false });
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    resize?.observe(list);
    return () => {
      list.removeEventListener("scroll", measure);
      list.removeEventListener("wheel", onWheel);
      resize?.disconnect();
    };
  }, [listRef, key]);

  useEffect(() => {
    const list = listRef.current;
    const chosen = activeSelector ? list?.querySelector<HTMLElement>(activeSelector) : null;
    if (!list || !chosen || list.scrollWidth <= list.clientWidth) return;
    const left = chosen.offsetLeft - list.offsetLeft;
    if (left >= list.scrollLeft && left + chosen.offsetWidth <= list.scrollLeft + list.clientWidth) return;
    list.scrollTo?.({
      left: left - (list.clientWidth - chosen.offsetWidth) / 2,
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });
  }, [listRef, activeSelector]);

  return more;
}
