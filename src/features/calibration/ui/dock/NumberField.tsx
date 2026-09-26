import { useEffect, useRef, useState, type ReactNode } from "react";

import { prefersReducedMotion } from "@/shared/lib/motion";
import { cx } from "@/shared/ui/cx";
import { IconCheck } from "@/shared/ui/icons";
import styles from "./NumberField.module.css";

interface NumberFieldProps {
  value: number;
  min: number;
  max: number;
  /** Beside the number, e.g. "LED". */
  unit: string;
  labels: {
    /** The box as a button at rest, e.g. "164 LEDs in total. Change". */
    edit: string;
    field: string;
    /** The ✓, e.g. "Distribute (Enter)". */
    apply: string;
    /** Shown in grey while the typed number is out of range. */
    range: string;
  };
  /** What a valid number means (length and power); also the box's tooltip at rest. */
  describe: (n: number) => string;
  /** A number offered from elsewhere (a device reporting its own), shown as a chip while editing. */
  suggestion?: { value: number; label: ReactNode } | null;
  /** Called only for a changed, in-range number. */
  onCommit: (n: number) => void;
  /** A changed, in-range number being typed, for a live preview; null when there is none. */
  onPreview?: (n: number | null) => void;
  className?: string;
}

const clampTo = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));

/**
 * A number edited where it stands. One box in both states: the number and the field share a slot
 * and a type, and the background, an underline opening from the middle, the pen turning into a ✓
 * and a hint rising above all ease in and out around it. Leaving the field or Enter commits a
 * changed number; Esc puts it back; ↑/↓ step it (⇧ by ten). An out-of-range number is not scolded
 * while typing — on leaving, the box shakes once and the value reverts.
 */
export function NumberField({ value, min, max, unit, labels, describe, suggestion, onCommit, onPreview, className }: NumberFieldProps) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  // Enter, Esc and the ✓ settle the field themselves; the blur that follows must not again.
  const settledRef = useRef(false);
  const typed = Number.parseInt(text, 10);
  const valid = Number.isFinite(typed) && typed >= min && typed <= max;

  // The number ticks only when the value changes from elsewhere. Coming back from the field —
  // the same value or the one just typed — it must simply be there.
  const shownRef = useRef(value);
  const fromFieldRef = useRef(false);
  const tick = !editing && value !== shownRef.current && !fromFieldRef.current;
  useEffect(() => {
    shownRef.current = value;
    if (!editing) fromFieldRef.current = false;
  });

  const change = (raw: string) => {
    const next = raw.replace(/[^0-9]/g, "").slice(0, 4);
    setText(next);
    const n = Number.parseInt(next, 10);
    onPreview?.(Number.isFinite(n) && n >= min && n <= max && n !== value ? n : null);
  };
  const begin = (start = value) => {
    settledRef.current = false;
    setEditing(true);
    change(String(start));
  };
  const stepBy = (key: string, shift: boolean, from: number): number | null => {
    if (key !== "ArrowUp" && key !== "ArrowDown") return null;
    const by = (key === "ArrowUp" ? 1 : -1) * (shift ? 10 : 1);
    return clampTo((Number.isFinite(from) ? from : value) + by, min, max);
  };
  const settle = (commit: boolean, reject = false) => {
    if (settledRef.current) return;
    settledRef.current = true;
    fromFieldRef.current = true;
    onPreview?.(null);
    if (commit) onCommit(typed);
    setEditing(false);
    // A small "no", played on the box that stays: nothing is remounted, so nothing else jumps.
    if (reject && !prefersReducedMotion()) {
      boxRef.current
        ?.animate(
          [
            { transform: "none" },
            { transform: "translateX(-3px)", offset: 0.2 },
            { transform: "translateX(3px)", offset: 0.45 },
            { transform: "translateX(-2px)", offset: 0.7 },
            { transform: "translateX(1px)", offset: 0.9 },
            { transform: "none" },
          ],
          { duration: 300, easing: "ease-out" },
        )
        .finished.catch(() => {});
    }
  };
  // Only a changed number commits: the same one again must not undo what was set around it.
  const confirm = () => (valid ? settle(typed !== value) : settle(false, text !== ""));

  return (
    <div ref={boxRef} className={cx(styles.box, editing && styles.editing, className)}>
      <span className={styles.value}>
        {editing ? (
          <input
            ref={inputRef}
            autoFocus
            type="text"
            inputMode="numeric"
            value={text}
            aria-label={labels.field}
            aria-invalid={(text !== "" && !valid) || undefined}
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => change(e.target.value)}
            onBlur={(e) => {
              // A press on the suggestion keeps the field open.
              if (boxRef.current?.contains(e.relatedTarget as Node | null)) return;
              settle(valid && typed !== value, text !== "" && !valid);
            }}
            onKeyDown={(e) => {
              const next = stepBy(e.key, e.shiftKey, typed);
              if (next !== null) {
                e.preventDefault();
                change(String(next));
              } else if (e.key === "Enter") confirm();
              else if (e.key === "Escape") {
                e.stopPropagation();
                settle(false);
              }
            }}
            className={styles.input}
          />
        ) : (
          <span key={value} className={cx(styles.number, tick && styles.tick)}>
            {value}
          </span>
        )}
      </span>
      <span className={styles.unit}>{unit}</span>
      {/* Pen at rest, ✓ while editing, in one slot: "apply this number", not a page's Save. */}
      <span className={styles.mark}>
        <svg viewBox="0 0 24 24" aria-hidden className={styles.pen} fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M4 20h4L19 9l-4-4L4 16v4z" />
        </svg>
        <button
          type="button"
          tabIndex={-1}
          disabled={!editing}
          inert={!editing || undefined}
          aria-hidden={!editing || undefined}
          aria-label={labels.apply}
          title={labels.apply}
          // Keeps the field focused, so its blur does not settle the edit first.
          onMouseDown={(e) => e.preventDefault()}
          onClick={confirm}
          className={cx(styles.apply, !valid && styles.invalid)}
        >
          <IconCheck />
        </button>
      </span>
      <span aria-hidden className={styles.line} />
      {/* The whole box is the button at rest; while editing the field takes the presses. */}
      {!editing && (
        <button
          type="button"
          aria-label={labels.edit}
          title={describe(value)}
          onClick={() => begin()}
          onKeyDown={(e) => {
            const next = stepBy(e.key, e.shiftKey, value);
            if (next === null) return;
            e.preventDefault();
            begin(next);
          }}
          className={styles.hit}
        />
      )}
      <span className={styles.hint} role="status" inert={!editing || undefined} aria-hidden={!editing || undefined}>
        {/* Out of range while typing is just the range, in grey: the shake on leaving says "no". */}
        <span>{editing ? (valid ? describe(typed) : labels.range) : describe(value)}</span>
        {suggestion && suggestion.value !== (editing ? typed : value) && (
          <button
            type="button"
            tabIndex={editing ? undefined : -1}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              change(String(suggestion.value));
              inputRef.current?.focus();
            }}
            className={styles.suggestion}
          >
            {suggestion.label}
          </button>
        )}
      </span>
    </div>
  );
}
