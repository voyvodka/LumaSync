import { type ReactNode, useRef, useState } from "react";

import { cx } from "@/shared/lib/cx";
import { clamp, roundTo } from "@/shared/lib/math";
import { prefersReducedMotion } from "@/shared/lib/motion";

import styles from "./DecimalField.module.css";

interface CommonProps {
  /** The field's name: read out, and its tooltip, since the box itself shows only `prefix`. */
  label: string;
  /** A short mark inside the box — an axis letter or a glyph. */
  prefix?: ReactNode;
  /** Places shown and stored: a value is kept as it reads. */
  decimals?: number;
  /** What ↑ and ↓ add; ⇧ adds ten times it. */
  step?: number;
  min?: number;
  max?: number;
  /** Folds a typed or stepped number into range before it is checked — rotation's 360 to 0. */
  normalize?: (value: number) => number;
  unit?: string;
  disabled?: boolean;
  describedBy?: string;
  id?: string;
  className?: string;
  testId?: string;
}

interface RequiredValue extends CommonProps {
  optional?: false;
  value: number;
  onCommit: (next: number) => void;
}

interface OptionalValue extends CommonProps {
  /** Empty means "use the default", which the placeholder shows; clearing the field commits `undefined`. */
  optional: true;
  value: number | undefined;
  placeholder: string;
  onCommit: (next: number | undefined) => void;
}

export type DecimalFieldProps = RequiredValue | OptionalValue;

const NUMBER = /^[-+]?(\d+\.?\d*|\.\d+)$/;

/** A typed number, with a comma read as the decimal mark the way Turkish writes it. */
export function parseDecimal(text: string): number | null {
  const normalised = text.trim().replace(",", ".");
  return NUMBER.test(normalised) ? Number(normalised) : null;
}

/**
 * One number in an inspector. At rest it reads as a value — no frame, the number in ink — and the
 * box arrives with intent: a tint on hover, a panel and an amber underline while editing. Typing
 * applies on leaving the field or on Enter; Esc puts the value back, and so does a number out of
 * range, with one small shake. ↑/↓ step it and apply at once (⇧ by ten), so a held arrow is one
 * gesture for a caller that coalesces its saves. Only a changed number is committed.
 */
export function DecimalField(props: DecimalFieldProps) {
  const {
    label,
    prefix,
    decimals = 2,
    step = 0.05,
    min = Number.NEGATIVE_INFINITY,
    max = Number.POSITIVE_INFINITY,
    normalize,
    unit,
    disabled = false,
    describedBy,
    id,
    className,
    testId,
  } = props;
  const value: number | undefined = props.value;
  const format = (v: number | undefined) => (v === undefined ? "" : v.toFixed(decimals));
  const [draft, setDraft] = useState(() => format(value));
  const [editing, setEditing] = useState(false);
  const boxRef = useRef<HTMLLabelElement | null>(null);

  if (!editing && draft !== format(value)) setDraft(format(value));

  const commit = (next: number | undefined) => {
    setDraft(format(next));
    const current = value === undefined ? undefined : roundTo(value, decimals);
    if (next === current) return;
    if (props.optional) props.onCommit(next);
    else if (next !== undefined) props.onCommit(next);
  };

  // A small "no", played on the box that stays, as LED Setup's total does.
  const reject = () => {
    setDraft(format(value));
    const box = boxRef.current;
    if (!box || typeof box.animate !== "function" || prefersReducedMotion()) return;
    box
      .animate(
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
  };

  const inRange = (n: number) => {
    const folded = normalize ? normalize(n) : n;
    return folded >= min && folded <= max ? roundTo(folded, decimals) : null;
  };

  const settle = () => {
    setEditing(false);
    if (draft.trim() === "") {
      if (props.optional) commit(undefined);
      else setDraft(format(value));
      return;
    }
    const typed = parseDecimal(draft);
    const next = typed === null ? null : inRange(typed);
    if (next === null) reject();
    else commit(next);
  };

  const stepBy = (direction: 1 | -1, coarse: boolean) => {
    const fallback = props.optional ? parseDecimal(props.placeholder) : null;
    const base = parseDecimal(draft) ?? value ?? fallback ?? 0;
    const raw = base + direction * step * (coarse ? 10 : 1);
    const folded = normalize ? normalize(raw) : raw;
    commit(roundTo(clamp(folded, min, max), decimals));
  };

  return (
    <label
      ref={boxRef}
      className={cx(styles.field, editing && styles.editing, disabled && styles.disabled, className)}
      title={label}
    >
      {prefix !== undefined && (
        <span className={styles.prefix} aria-hidden="true">
          {prefix}
        </span>
      )}
      <input
        id={id}
        type="text"
        inputMode="decimal"
        role="spinbutton"
        autoComplete="off"
        spellCheck={false}
        aria-label={label}
        aria-valuenow={value}
        aria-valuemin={Number.isFinite(min) ? min : undefined}
        aria-valuemax={Number.isFinite(max) ? max : undefined}
        aria-valuetext={value === undefined ? undefined : `${format(value)}${unit ? ` ${unit}` : ""}`}
        aria-describedby={describedBy}
        disabled={disabled}
        className={styles.input}
        value={draft}
        placeholder={props.optional ? props.placeholder : undefined}
        data-testid={testId}
        onFocus={(e) => {
          setEditing(true);
          e.currentTarget.select();
        }}
        onChange={(e) => {
          setEditing(true);
          setDraft(e.target.value);
        }}
        onBlur={settle}
        onKeyDown={(e) => {
          // The field's keys are its own, Cmd+Z included.
          e.stopPropagation();
          if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            stepBy(e.key === "ArrowUp" ? 1 : -1, e.shiftKey);
          } else if (e.key === "Enter") {
            e.preventDefault();
            settle();
          } else if (e.key === "Escape") {
            setDraft(format(value));
            setEditing(false);
          }
        }}
      />
      {unit && (
        <span className={styles.unit} aria-hidden="true">
          {unit}
        </span>
      )}
    </label>
  );
}

/** Two fields side by side, X beside Y and width beside depth. */
export function FieldPair({ children }: { children: ReactNode }) {
  return <div className={styles.pair}>{children}</div>;
}

/** A line under the fields it explains, aligned with their values. */
export function FieldHint({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <p id={id} className={styles.hint}>
      {children}
    </p>
  );
}
