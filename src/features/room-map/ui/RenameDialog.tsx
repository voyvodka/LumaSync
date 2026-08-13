import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

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
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  // A1.4 — useId() instead of a static "rename-dialog-label" so multiple
  // RenameDialog instances (or re-mounts) don't collide on the aria-labelledby
  // target. Pure a11y delta on top of the W4 i18n + role="dialog" pass.
  const labelId = useId();

  useEffect(() => {
    inputRef.current?.select();
  }, []);

  // ESC is bound at document level, not on the input: with it on the input the
  // dialog became un-cancellable by keyboard as soon as focus moved off.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
        return;
      }
      if (event.key !== "Tab") return;
      const order: HTMLElement[] = [inputRef.current, cancelRef.current, confirmRef.current].filter(
        (el): el is HTMLInputElement | HTMLButtonElement => el !== null,
      );
      if (order.length === 0) return;
      const active = document.activeElement as HTMLElement | null;
      const idx = active ? order.indexOf(active) : -1;
      const next = event.shiftKey
        ? order[(idx <= 0 ? order.length : idx) - 1]
        : order[(idx + 1) % order.length];
      if (next && next !== active) {
        event.preventDefault();
        next.focus();
      }
    };
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, [onCancel]);

  const handleSubmit = () => {
    const trimmed = value.trim();
    if (trimmed) onConfirm(trimmed);
    else onCancel();
  };

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center"
      style={{ background: "rgba(7, 8, 10, 0.55)" }}
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
            ref={cancelRef}
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
            ref={confirmRef}
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
