import { useEffect, useId, useRef, type RefObject } from "react";

import { cx } from "../cx";
import { Popover } from "../Popover/Popover";
import { RowButton } from "../SettingRow/SettingRow";
import styles from "./ConfirmPopover.module.css";

export interface ConfirmPopoverProps {
  open: boolean;
  /** What asked: the question floats beside it, and focus goes back to it when answered. */
  anchorRef: RefObject<HTMLElement | null>;
  /** Names the question for a screen reader. */
  label: string;
  /** A heading, for a question that needs more than a line to say what it does. */
  title?: string;
  text: string;
  confirmLabel: string;
  cancelLabel: string;
  /** Lets something go: the confirm is red, and focus starts on Cancel so a stray Enter keeps it. */
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  testId?: string;
  confirmTestId?: string;
}

/**
 * A yes/no beside the control that asked. Floats rather than pushing the rows below or covering
 * the page: the page stays where it is while the question is up. Esc, an outside press or Cancel
 * answers no.
 */
export function ConfirmPopover({
  open,
  anchorRef,
  label,
  title,
  text,
  confirmLabel,
  cancelLabel,
  danger = false,
  onConfirm,
  onCancel,
  testId,
  confirmTestId,
}: ConfirmPopoverProps) {
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const textId = useId();

  useEffect(() => {
    if (open) (danger ? cancelRef : confirmRef).current?.focus();
  }, [open, danger]);

  const answer = (yes: boolean) => {
    anchorRef.current?.focus();
    if (yes) onConfirm();
    else onCancel();
  };

  return (
    <Popover open={open} onClose={onCancel} anchorRef={anchorRef} side="below" width={title ? 320 : 280} label={label} role="dialog">
      <div className={styles.confirm} data-testid={testId} aria-describedby={textId}>
        {title ? <p className={styles.title}>{title}</p> : null}
        <p id={textId} className={styles.text}>
          {text}
        </p>
        <div className={styles.actions}>
          <RowButton ref={cancelRef} onClick={() => answer(false)}>
            {cancelLabel}
          </RowButton>
          <RowButton
            ref={confirmRef}
            primary={!danger}
            className={cx(danger && styles.danger)}
            onClick={() => answer(true)}
            data-testid={confirmTestId}
          >
            {confirmLabel}
          </RowButton>
        </div>
      </div>
    </Popover>
  );
}
