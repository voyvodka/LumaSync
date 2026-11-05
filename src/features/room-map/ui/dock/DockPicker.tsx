import { type ReactNode, useId, useRef, useState } from "react";

import { cx } from "@/shared/lib/cx";
import { PickerList } from "@/shared/ui/PickerList/PickerList";

import { IconChevronUp } from "./dockIcons";
import styles from "./DockPicker.module.css";

/** Wide enough that a note under the list reads as a sentence, not a column of words. */
const NOTE_LIST_WIDTH = 220;

export interface DockOption<T extends string> {
  value: T;
  label: string;
  /** Before the label, in the list and on the button. */
  mark?: ReactNode;
}

/**
 * A value that opens a list: the choice as it stands, with a chevron that turns while the list is
 * open above it. Picking closes the list and hands focus back.
 */
export function DockPicker<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled = false,
  width,
  buttonMark = true,
  note,
  className,
  testId,
}: {
  /** The picker's name, read out before its value. */
  label: string;
  value: T;
  options: readonly DockOption<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
  /** A fixed width, so a longer value never moves what follows. */
  width?: number;
  /** Off where the button has no room for the option's mark; the list still shows it. */
  buttonMark?: boolean;
  /** What the choice means, under the list rather than behind a separate ⓘ. */
  note?: string;
  className?: string;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const listId = useId();
  const current = options.find((option) => option.value === value);

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className={cx(styles.button, open && styles.open, className)}
        style={width ? { width } : undefined}
        aria-label={`${label}: ${current?.label ?? value}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        title={current?.label}
        disabled={disabled}
        data-testid={testId}
        onClick={() => setOpen((was) => !was)}
      >
        {buttonMark && current?.mark && <span className={styles.mark}>{current.mark}</span>}
        <span className={styles.value}>{current?.label ?? value}</span>
        <span className={styles.chevron}>
          <IconChevronUp />
        </span>
      </button>
      <PickerList
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={anchorRef}
        side="above"
        id={listId}
        label={label}
        width={note ? NOTE_LIST_WIDTH : "fit"}
        footer={note}
        items={options}
        itemKey={(option) => option.value}
        selectedIndex={options.findIndex((option) => option.value === value)}
        renderItem={(option) => (
          <>
            {option.mark && <span className={styles.mark}>{option.mark}</span>}
            <span>{option.label}</span>
          </>
        )}
        onPick={(index) => {
          const picked = options[index];
          setOpen(false);
          if (picked && picked.value !== value) onChange(picked.value);
          anchorRef.current?.focus();
        }}
      />
    </>
  );
}
