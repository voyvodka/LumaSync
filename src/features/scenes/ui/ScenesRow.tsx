import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { useTranslation } from "react-i18next";

import { prefersReducedMotion } from "@/shared/lib/motion";
import { useFlip } from "@/shared/lib/useFlip";

import styles from "./ScenesRow.module.css";
import { useArrivals } from "./useArrivals";

export interface SceneChip {
  id: string;
  name: string;
  /** A CSS background: the scene's own light. */
  swatch: string;
  active: boolean;
  /** A scene this build cannot play (saved by a newer one). */
  unavailable?: boolean;
}

interface ScenesRowProps {
  scenes: readonly SceneChip[];
  disabled?: boolean;
  onPick: (id: string) => void;
  /** Controls at the row's end: save, the library. */
  trailing?: ReactNode;
  /** Shown in the list's place while it is empty. */
  placeholder?: ReactNode;
}

/** The user's scenes as a row of chips under the mode strip; one press is the whole look. */
export function ScenesRow({ scenes, disabled = false, onPick, trailing, placeholder }: ScenesRowProps) {
  const { t } = useTranslation();
  // A pick lands with a small scale-in; the one already chosen when the page opens does not.
  const [placed, setPlaced] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setPlaced(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  // A chip just saved or added grows in.
  const { arrived, settled } = useArrivals(scenes.map((scene) => scene.id));
  // Reordered in the library behind the popover: the chips slide to their new places.
  const listRef = useRef<HTMLDivElement | null>(null);
  const ids = scenes.map((scene) => scene.id);
  useFlip(listRef, ids);
  const more = useSideScroll(listRef, ids.join("\n"), scenes.find((scene) => scene.active)?.id);
  return (
    <div className={styles.row}>
      {scenes.length === 0 && placeholder ? (
        <div className={styles.list}>{placeholder}</div>
      ) : (
        <div
          ref={listRef}
          className={styles.list}
          role="radiogroup"
          aria-label={t("lights:scenes.title")}
          data-placed={placed || undefined}
          data-more={more}
        >
          {scenes.map((scene) => (
            <button
              key={scene.id}
              type="button"
              role="radio"
              aria-checked={scene.active}
              className={styles.chip}
              disabled={disabled || scene.unavailable}
              title={scene.unavailable ? t("lights:scenes.unavailable") : scene.name}
              onClick={() => onPick(scene.id)}
              data-arrived={arrived.has(scene.id) || undefined}
              data-flip-id={scene.id}
              onAnimationEnd={(event) => {
                if (event.target === event.currentTarget) settled(scene.id);
              }}
              data-testid={`scene-${scene.id}`}
            >
              <span className={styles.swatch} style={{ background: scene.swatch }} aria-hidden />
              <span className={styles.name}>{scene.name}</span>
            </button>
          ))}
        </div>
      )}
      {trailing ? <div className={styles.trailing}>{trailing}</div> : null}
    </div>
  );
}

type More = "start" | "end" | "both" | undefined;

/**
 * The one-line list's scrolling: which edges have more past them (they fade), a vertical wheel
 * turned into a sideways scroll while the list overflows, and the chosen chip brought into view.
 */
function useSideScroll(listRef: RefObject<HTMLElement | null>, key: string, activeId: string | undefined): More {
  const [more, setMore] = useState<More>(undefined);
  useEffect(() => {
    const list = listRef.current;
    // No chips: the placeholder stands in, and nothing scrolls. A new set of chips measures afresh.
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
    const chip = activeId ? list?.querySelector<HTMLElement>(`[data-flip-id="${CSS.escape(activeId)}"]`) : null;
    if (!list || !chip || list.scrollWidth <= list.clientWidth) return;
    const left = chip.offsetLeft - list.offsetLeft;
    if (left >= list.scrollLeft && left + chip.offsetWidth <= list.scrollLeft + list.clientWidth) return;
    list.scrollTo?.({
      left: left - (list.clientWidth - chip.offsetWidth) / 2,
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });
  }, [listRef, activeId]);

  return more;
}
