import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { shellStore } from "@/features/persistence/shellStore";
import { STRIP_NAME_MAX, withStripName } from "@/features/strips/model/stripWrites";
import { RowNote } from "@/shared/ui/SettingRow/SettingRow";

import styles from "./StripPage.module.css";

interface StripNameProps {
  stripId: string;
  /** The name as shown: the user's, or the device's until renamed. */
  name: string;
  /** Whether `name` is the user's; a device's name opens the field empty for a new one. */
  renamed: boolean;
  headingId: string;
}

/**
 * The strip's name as the page heading, renamed in place: pressing it turns it into a field, Enter
 * or leaving the field keeps what was typed, Esc puts the name back. The field holds the heading's
 * size so the row below never moves.
 */
export function StripName({ stripId, name, renamed, headingId }: StripNameProps) {
  const { t } = useTranslation();
  const hintId = useId();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [failed, setFailed] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  // Esc sets this before the blur it causes, so leaving the field that way keeps nothing.
  const cancelled = useRef(false);
  // A field that closes on Enter also blurs as it goes; this makes the second close a no-op.
  const fieldOpen = useRef(false);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const open = () => {
    cancelled.current = false;
    fieldOpen.current = true;
    setDraft(renamed ? name : "");
    setFailed(false);
    setEditing(true);
  };

  const close = (keep: boolean) => {
    if (!fieldOpen.current) return;
    fieldOpen.current = false;
    const byKey = document.activeElement === inputRef.current;
    setEditing(false);
    // Back to the pencil when the field closed by key; a click elsewhere keeps its own target.
    if (byKey) requestAnimationFrame(() => buttonRef.current?.focus());
    if (!keep || draft.trim() === (renamed ? name : "")) return;
    void shellStore
      .update((state) => withStripName(state, stripId, draft))
      .catch((error: unknown) => {
        console.error("[LumaSync] renaming the strip failed:", error);
        setFailed(true);
      });
  };

  return (
    <div className={styles.nameLine}>
      <h1 id={headingId} className={styles.title}>
        {editing ? (
          <input
            ref={inputRef}
            className={styles.nameInput}
            value={draft}
            placeholder={name}
            maxLength={STRIP_NAME_MAX * 2}
            aria-label={t("device:strip.name.rename", { name })}
            aria-describedby={hintId}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                close(true);
              } else if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                cancelled.current = true;
                close(false);
              }
            }}
            onBlur={() => {
              if (!cancelled.current) close(true);
            }}
            data-testid="strip-name-input"
          />
        ) : (
          name
        )}
      </h1>
      {editing ? null : (
        <button
          ref={buttonRef}
          type="button"
          className={styles.rename}
          aria-label={t("device:strip.name.rename", { name })}
          aria-describedby={hintId}
          onClick={open}
          data-testid="strip-rename"
        >
          <svg viewBox="0 0 16 16" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.4">
            <path d="M10.5 2.5l3 3L6 13H3v-3z" strokeLinejoin="round" />
          </svg>
        </button>
      )}
      <span id={hintId} className="sr-only">
        {t("device:strip.name.renameHint")}
      </span>
      {failed ? (
        <RowNote tone="error" testId="strip-name-failed">
          {t("device:strip.name.saveFailed")}
        </RowNote>
      ) : null}
    </div>
  );
}
