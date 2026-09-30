import { useEffect, useLayoutEffect, useState, type RefObject } from "react";

export interface ChoiceThumb {
  left: number;
  right: number;
  /** It last moved left: the edge on that side leads. */
  toLeft: boolean;
}

/**
 * Where a choice's travelling fill sits under the chosen option, measured inside `stripRef`, and
 * whether it may travel yet: the first placement lands without moving, so a page opens with the
 * fill already on its value. `null` while nothing is chosen.
 */
export function useChoiceThumb(
  stripRef: RefObject<HTMLElement | null>,
  value: string | null,
): { thumb: ChoiceThumb | null; placed: boolean } {
  const [thumb, setThumb] = useState<ChoiceThumb | null>(null);
  const [placed, setPlaced] = useState(false);

  useLayoutEffect(() => {
    const strip = stripRef.current;
    if (!strip) return undefined;
    const measure = () => {
      if (value === null) {
        setThumb(null);
        return;
      }
      const checked = strip.querySelector<HTMLElement>('[aria-checked="true"]');
      const group = checked?.offsetParent as HTMLElement | null | undefined;
      if (!checked || !group) {
        setThumb(null);
        return;
      }
      const left = group.offsetLeft + checked.offsetLeft;
      const right = strip.clientWidth - left - checked.offsetWidth;
      setThumb((previous) => ({ left, right, toLeft: previous ? left < previous.left : false }));
    };
    measure();
    // A language switch or a narrower window changes the options' widths under the fill.
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(strip);
    return () => observer?.disconnect();
  }, [stripRef, value]);

  useEffect(() => {
    if (thumb && !placed) {
      const frame = requestAnimationFrame(() => setPlaced(true));
      return () => cancelAnimationFrame(frame);
    }
    return undefined;
  }, [thumb, placed]);

  return { thumb, placed };
}
