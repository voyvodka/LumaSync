import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";

import { cx } from "@/shared/lib/cx";
import { RowButton } from "../SettingRow/SettingRow";
import { useDialogFocus } from "@/shared/lib/useDialogFocus";
import styles from "./ConfirmDialog.module.css";

interface ConfirmDialogProps {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  /** `danger` for a confirm that throws work away. */
  tone?: "default" | "danger";
  onConfirm: () => void;
  onCancel: () => void;
  /** Anything the answer needs besides the two buttons, e.g. a "don't ask again" box. */
  children?: ReactNode;
  /**
   * Enter anywhere but on the confirm button cancels. For a dialog guarding a
   * destructive override, where a stray Enter must not be the thing that agrees.
   */
  enterCancels?: boolean;
  testId?: string;
  confirmTestId?: string;
  cancelTestId?: string;
}

/**
 * A yes/no over the page, for a question nothing on screen asked — leaving LED Setup with a layout
 * unsaved. A question a control asks floats beside it instead (`ConfirmPopover`). In-app rather than
 * `window.confirm`, which blocks the webview's event loop — and every automation driving it — until
 * answered. Escape and a backdrop click cancel; focus is trapped and restored.
 */
export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  cancelLabel,
  tone = "default",
  onConfirm,
  onCancel,
  children,
  enterCancels = false,
  testId,
  confirmTestId,
  cancelTestId,
}: ConfirmDialogProps) {
  const titleId = useId();
  const bodyId = useId();
  const confirmRef = useRef<HTMLButtonElement>(null);
  const { containerRef, handleKeyDown } = useDialogFocus<HTMLDivElement>(true, {
    onClose: onCancel,
  });

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (enterCancels && event.key === "Enter" && document.activeElement !== confirmRef.current) {
      event.preventDefault();
      onCancel();
      return;
    }
    handleKeyDown(event);
  };

  return (
    <div
      ref={containerRef}
      onKeyDown={onKeyDown}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      className={styles.scrim}
      data-testid={testId}
      onClick={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div className={styles.card}>
        <h3 id={titleId} className={styles.title}>
          {title}
        </h3>
        <p id={bodyId} className={styles.body}>
          {body}
        </p>
        {children && <div className={styles.extra}>{children}</div>}
        <div className={styles.actions}>
          <RowButton onClick={onCancel} data-testid={cancelTestId}>
            {cancelLabel}
          </RowButton>
          <RowButton
            ref={confirmRef}
            primary={tone !== "danger"}
            className={cx(tone === "danger" && styles.danger)}
            onClick={onConfirm}
            data-testid={confirmTestId}
          >
            {confirmLabel}
          </RowButton>
        </div>
      </div>
    </div>
  );
}
