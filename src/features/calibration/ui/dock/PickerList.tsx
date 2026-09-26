import { useEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";

import { prefersReducedMotion } from "@/shared/lib/motion";
import { cx } from "@/shared/ui/cx";
import { Popover } from "@/shared/ui/Popover/Popover";
import styles from "./PickerList.module.css";

interface PickerListProps<T> {
  open: boolean;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
  /** Above the anchor (the dock sits at the bottom) or below it (the top bar). */
  side?: "above" | "below";
  id: string;
  label: string;
  width?: number;
  items: readonly T[];
  itemKey: (item: T) => string;
  renderItem: (item: T, selected: boolean) => ReactNode;
  selectedIndex: number;
  /** Called once the tint has landed on the picked row; the caller commits and closes. */
  onPick: (index: number) => void;
}

/**
 * A pick list in a popover beside its anchor. Rows arrive staggered from the one nearest the anchor; the current row's tint is one mark that slides to the row picked, and the pick is
 * handed over only after it lands (~120 ms), so the choice is seen landing.
 */
export function PickerList<T>({
  open,
  onClose,
  anchorRef,
  side = "above",
  id,
  label,
  width = 210,
  items,
  itemKey,
  renderItem,
  selectedIndex,
  onPick,
}: PickerListProps<T>) {
  const [picked, setPicked] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  // Closed from outside (Esc, a press elsewhere) before the tint landed: the pick is taken back.
  useEffect(() => {
    if (open || !timer.current) return;
    clearTimeout(timer.current);
    timer.current = null;
    setPicked(null);
  }, [open]);
  const mark = picked ?? selectedIndex;

  const pick = (i: number) => {
    if (timer.current) return;
    setPicked(i);
    timer.current = setTimeout(
      () => {
        timer.current = null;
        setPicked(null);
        onPick(i);
      },
      prefersReducedMotion() ? 0 : 120,
    );
  };

  return (
    <Popover open={open} onClose={onClose} anchorRef={anchorRef} side={side} id={id} role="listbox" label={label} width={width}>
      <div className={styles.list}>
        <span
          aria-hidden
          className={cx(styles.mark, mark < 0 && styles.none)}
          style={{ transform: `translateY(${Math.max(0, mark) * 100}%)` }}
        />
        {items.map((item, i) => {
          const selected = i === mark;
          return (
            <button
              key={itemKey(item)}
              type="button"
              role="option"
              aria-selected={selected}
              // Rows nearest the anchor come in first.
              style={{ animationDelay: `${30 + (side === "above" ? items.length - 1 - i : i) * 18}ms` } as CSSProperties}
              onClick={() => pick(i)}
              onKeyDown={(e) => {
                if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
                e.preventDefault();
                const sib = e.key === "ArrowDown" ? e.currentTarget.nextElementSibling : e.currentTarget.previousElementSibling;
                (sib as HTMLElement | null)?.focus();
              }}
              className={styles.option}
            >
              {renderItem(item, selected)}
            </button>
          );
        })}
      </div>
    </Popover>
  );
}
