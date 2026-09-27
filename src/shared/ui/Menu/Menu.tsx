import { useEffect, useId, useRef, useState } from "react";

import { cx } from "../cx";
import { Popover } from "../Popover/Popover";
import styles from "./Menu.module.css";

export interface MenuItem {
  id: string;
  label: string;
  onSelect: () => void;
  /** Lets something go (forget, remove): drawn red. */
  danger?: boolean;
  disabled?: boolean;
}

interface MenuProps {
  /** Names the "…" button, e.g. "More for Living room". */
  label: string;
  items: readonly MenuItem[];
  testId?: string;
}

/**
 * The rarer actions of a row behind one "…". A dialog of buttons, not a `menu`: that role
 * promises arrow keys and typeahead a list of two or three does not need. Picking an item
 * closes it and hands focus back to "…" before the action runs, so a confirmation the action
 * opens returns focus to a button that is still there.
 */
export function Menu({ label, items, testId }: MenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const id = useId();

  useEffect(() => {
    if (open) listRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [open]);

  if (items.length === 0) return null;
  return (
    <>
      <button
        ref={ref}
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((v) => !v)}
        className={styles.trigger}
        data-testid={testId}
      >
        <svg viewBox="0 0 16 16" aria-hidden fill="currentColor">
          <circle cx="3.5" cy="8" r="1.25" />
          <circle cx="8" cy="8" r="1.25" />
          <circle cx="12.5" cy="8" r="1.25" />
        </svg>
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchorRef={ref} side="below" width="fit" id={id} label={label} role="dialog">
        <div ref={listRef} className={styles.list}>
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              disabled={item.disabled}
              className={cx(styles.item, item.danger && styles.danger)}
              onClick={() => {
                setOpen(false);
                ref.current?.focus();
                item.onSelect();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      </Popover>
    </>
  );
}
