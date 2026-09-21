import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { useDialogFocus } from "@/shared/ui/useDialogFocus";

export function RenameDialog({
  currentLabel,
  promptText,
  onConfirm,
  onCancel,
}: {
  currentLabel: string;
  promptText: string;
  onConfirm: (name: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState(currentLabel);
  const inputRef = useRef<HTMLInputElement>(null);
  const { containerRef, handleKeyDown } = useDialogFocus<HTMLDivElement>(true, {
    onClose: onCancel,
  });
  // A1.4 — useId() instead of a static "rename-dialog-label" so multiple
  // RenameDialog instances (or re-mounts) don't collide on the aria-labelledby
  // target. Pure a11y delta on top of the W4 i18n + role="dialog" pass.
  const labelId = useId();

  useEffect(() => {
    inputRef.current?.select();
  }, []);


  const handleSubmit = () => {
    const trimmed = value.trim();
    if (trimmed) onConfirm(trimmed);
    else onCancel();
  };

  return (
    <div
      ref={containerRef}
      onKeyDown={handleKeyDown}
      tabIndex={-1}
      // Starts below the title bar rather than at `inset-0`: a full-viewport
      // backdrop covers the drag region and the window controls, so the window
      // cannot be moved or closed for as long as the dialog is up.
      className="fixed right-0 bottom-0 left-0 z-[200] flex items-center justify-center"
      style={{ top: "var(--lm-titlebar-h)", background: "rgba(7, 8, 10, 0.55)" }}
      onClick={onCancel}
      role="dialog"
      aria-modal="true"
      aria-labelledby={labelId}
    >
      <div
        className="lm-settings-group p-4 w-64 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <label
          id={labelId}
          className="block text-[11px] font-semibold mb-2"
          style={{ color: "var(--lm-ink)", fontFamily: "var(--lm-mono)", letterSpacing: "0.04em" }}
        >
          {promptText}
        </label>
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") handleSubmit();
            // ESC handled by document-level trap; stopPropagation still
            // keeps room-map shortcuts from leaking through Tab/Enter.
          }}
          className="w-full rounded px-2 py-1.5 text-sm focus:outline-none"
          style={{
            background: "var(--lm-panel-2)",
            border: "1px solid var(--lm-line-2)",
            color: "var(--lm-ink)",
            boxShadow: "var(--lm-focus-ring-soft)",
          }}
          onFocus={(e) => {
            e.currentTarget.style.borderColor = "rgba(255, 176, 32, 0.45)";
          }}
          onBlur={(e) => {
            e.currentTarget.style.borderColor = "var(--lm-line-2)";
          }}
          autoFocus
        />
        <div className="mt-3 flex justify-end gap-2">
          <button
            type="button"
            className="rounded text-[11px]"
            style={{
              minHeight: 28,
              padding: "4px 10px",
              color: "var(--lm-ink-dim)",
              background: "transparent",
              fontFamily: "var(--lm-mono)",
              letterSpacing: "0.04em",
            }}
            onClick={onCancel}
          >
            {t("roomMap:contextMenu.renameCancel")}
          </button>
          <button
            type="button"
            className="rounded text-[11px] font-semibold"
            style={{
              minHeight: 28,
              padding: "4px 12px",
              background: "var(--lm-amber)",
              color: "var(--lm-bg)",
              fontFamily: "var(--lm-mono)",
              letterSpacing: "0.04em",
            }}
            onClick={handleSubmit}
          >
            {t("roomMap:contextMenu.renameOk")}
          </button>
        </div>
      </div>
    </div>
  );
}
