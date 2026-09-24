import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";

import { Button } from "./Button";
import { useDialogFocus } from "./useDialogFocus";

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
 * The app's one yes/no dialog. In-app rather than `window.confirm`, which
 * blocks the webview's event loop — and every automation driving it — until
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
      className="lm-modal-scrim"
      data-testid={testId}
      onClick={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div className="w-full max-w-sm rounded-xl border border-line-2 bg-panel p-5 shadow-xl">
        <h3 id={titleId} className="text-sm font-semibold text-ink">
          {title}
        </h3>
        <p id={bodyId} className="mt-2 text-xs text-ink-dim">
          {body}
        </p>
        {children && <div className="mt-3">{children}</div>}
        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={onCancel} data-testid={cancelTestId}>
            {cancelLabel}
          </Button>
          <Button
            ref={confirmRef}
            variant={tone === "danger" ? "danger" : "primary"}
            onClick={onConfirm}
            data-testid={confirmTestId}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
