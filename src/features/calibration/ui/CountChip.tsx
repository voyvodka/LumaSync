import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import type { LedSegmentKey } from "../model/contracts";
import styles from "./CountChip.module.css";

interface CountChipProps {
  /** Names the number for assistive tech ("Top edge", "Stand gap"). */
  label: string;
  value: number;
  min: number;
  max: number;
  style: CSSProperties;
  /** The edges this number sets; hovering their LEDs shows its controls too. */
  edges: readonly LedSegmentKey[];
  /** Shown before the number, e.g. the stand's glyph. */
  icon?: ReactNode;
  link?: { linked: boolean; onToggle: () => void };
  onRemove?: () => void;
  removeLabel?: string;
  onChange: (next: number) => void;
  onActive: (active: boolean) => void;
}

/**
 * A number sitting on the canvas, quiet at rest. Click it to type; ↑/↓ step it (⇧ by ten);
 * − and + and the edge's other controls show on hover or focus, of the number or of its LEDs.
 */
export function CountChip({ label, value, min, max, style, edges, icon, link, onRemove, removeLabel, onChange, onActive }: CountChipProps) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(value));
  const inputRef = useRef<HTMLInputElement | null>(null);
  const valueRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!editing) setDraft(String(value));
  }, [value, editing]);
  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const step = (by: number) => onChange(Math.max(min, Math.min(max, value + by)));
  const finish = (commit: boolean) => {
    const parsed = Number.parseInt(draft, 10);
    if (commit && Number.isFinite(parsed) && parsed !== value) onChange(parsed);
    setEditing(false);
    setDraft(String(value));
  };
  const arrows = (key: string, shift: boolean) => {
    if (key === "ArrowUp") step(shift ? 10 : 1);
    else if (key === "ArrowDown") step(shift ? -10 : -1);
    else return false;
    return true;
  };

  return (
    <div
      className={editing ? `${styles.chip} ${styles.isEditing}` : styles.chip}
      style={style}
      data-edges={edges.join(" ")}
      onFocus={() => onActive(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onActive(false);
      }}
      onMouseEnter={() => onActive(true)}
      onMouseLeave={(e) => {
        if (!e.currentTarget.contains(document.activeElement)) onActive(false);
      }}
    >
      <span className={styles.before}>
        <button
          type="button"
          tabIndex={-1}
          disabled={value <= min}
          onClick={() => step(-1)}
          aria-label={t("calibration:page.aria.countDecrease", { label })}
          className={styles.step}
        >
          −
        </button>
      </span>
      {editing ? (
        <input
          ref={inputRef}
          type="text"
          inputMode="numeric"
          value={draft}
          size={Math.max(2, draft.length)}
          aria-label={t("calibration:page.aria.countInput", { label })}
          onChange={(e) => setDraft(e.target.value.replace(/[^0-9]/g, "").slice(0, 4))}
          onBlur={() => finish(true)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              finish(true);
              valueRef.current?.focus();
            } else if (e.key === "Escape") {
              e.stopPropagation();
              finish(false);
            } else if (arrows(e.key, e.shiftKey)) e.preventDefault();
          }}
          className={styles.input}
        />
      ) : (
        <button
          ref={valueRef}
          type="button"
          aria-label={t("calibration:page.aria.countInput", { label })}
          onClick={() => setEditing(true)}
          onKeyDown={(e) => {
            if (arrows(e.key, e.shiftKey)) e.preventDefault();
          }}
          className={styles.value}
          data-count
        >
          {icon}
          <span key={value} className={styles.num}>{value}</span>
        </button>
      )}
      {/* The number stays on its anchor; its controls float either side of it. */}
      <span className={styles.after}>
      <button
        type="button"
        tabIndex={-1}
        disabled={value >= max}
        onClick={() => step(1)}
        aria-label={t("calibration:page.aria.countIncrease", { label })}
        className={styles.step}
      >
        +
      </button>
      {link && (
        <button
          type="button"
          onClick={link.onToggle}
          aria-pressed={link.linked}
          aria-label={t("calibration:setup.keepEqual")}
          title={link.linked ? t("calibration:setup.split") : t("calibration:setup.keepEqual")}
          className={link.linked ? `${styles.link} ${styles.isOn}` : styles.link}
        >
          <svg viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth="2.2">
            <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
            <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
          </svg>
        </button>
      )}
      {onRemove && (
        <button type="button" onClick={onRemove} aria-label={removeLabel} title={removeLabel} className={styles.remove}>
          ×
        </button>
      )}
      </span>
    </div>
  );
}
