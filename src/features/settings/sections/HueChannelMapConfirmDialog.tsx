import { useId } from "react";
import { useTranslation } from "react-i18next";

import { useDialogFocus } from "@/shared/ui/useDialogFocus";

interface HueChannelMapConfirmDialogProps {
  title: string;
  body: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/** In-app confirmation for the bridge push and pull. `window.confirm` blocks
 *  the webview's event loop — and every automation driving it — until answered. */
export function HueChannelMapConfirmDialog({
  title,
  body,
  confirmLabel,
  onConfirm,
  onCancel,
}: HueChannelMapConfirmDialogProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const bodyId = useId();
  // Escape cancels: both actions overwrite one side's arrangement.
  const { containerRef, handleKeyDown } = useDialogFocus<HTMLDivElement>(true, {
    onClose: onCancel,
  });

  return (
    <div
      ref={containerRef}
      onKeyDown={handleKeyDown}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      className="lm-modal-scrim"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-sm rounded-xl border border-line-2 bg-panel p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id={titleId} className="text-sm font-semibold text-ink">
          {title}
        </h3>
        <p id={bodyId} className="mt-2 text-xs text-ink-dim">
          {body}
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="lm-device-btn" onClick={onCancel}>
            {t("hue:page.cancel")}
          </button>
          <button type="button" className="lm-device-btn is-primary" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
