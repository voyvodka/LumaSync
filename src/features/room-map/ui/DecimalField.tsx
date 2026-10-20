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
  /** Makes the unit a button that changes it, named by `label`; a view choice, so a locked field keeps it. */
  unitSwitch?: { label: string; onPress: () => void };
  disabled?: boolean;
  describedBy?: string;
  id?: string;
  className?: string;
  testId?: string;
  /** Takes focus when the inspector it opens in was reached from the keyboard. */
  first?: boolean;
  /** A drag across the field let go, after the `held` commits it made. */
  onScrubEnd?: () => void;
}

interface RequiredValue extends CommonProps {
  optional?: false;
  value: number;
  /** `held` while a drag across the field is under way: its steps are one change. */
  onCommit: (next: number, held?: boolean) => void;
}

interface OptionalValue extends CommonProps {
  /** Empty means "use the default", which the placeholder shows; clearing the field commits `undefined`. */
  optional: true;
  value: number | undefined;
  placeholder: string;
  onCommit: (next: number | undefined, held?: boolean) => void;
}

export type DecimalFieldProps = RequiredValue | OptionalValue;

const NUMBER = /^[-+]?(\d+\.?\d*|\.\d+)$/;

/** A drag across a field: a step per this many pixels, after this much travel says it is a drag. */
const SCRUB_PX_PER_STEP = 4;
const SCRUB_SLOP_PX = 3;

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
 * gesture for a caller that coalesces its saves. Dragging across the field steps it the same way,
 * a step per few pixels, so a value changes without typing; a press that does not move types.
 * Only a changed number is committed.
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
    unitSwitch,
    disabled = false,
    describedBy,
    id,
    className,
    testId,
    first = false,
    onScrubEnd,
  } = props;
  const value: number | undefined = props.value;
  const format = (v: number | undefined) => (v === undefined ? "" : v.toFixed(decimals));
  const [draft, setDraft] = useState(() => format(value));
  const [editing, setEditing] = useState(false);
  const boxRef = useRef<HTMLElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const scrub = useRef<{ x: number; base: number; moved: boolean } | null>(null);
  // The click that ends a drag reached the label, which focused the input: the next drag then typed.
  const swallowClick = useRef(false);
  const [scrubbing, setScrubbing] = useState(false);

  if (!editing && draft !== format(value)) setDraft(format(value));

  const commit = (next: number | undefined, held = false) => {
    setDraft(format(next));
    const current = value === undefined ? undefined : roundTo(value, decimals);
    if (next === current) return;
    if (props.optional) props.onCommit(next, held);
    else if (next !== undefined) props.onCommit(next, held);
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

  const startScrub = (event: React.PointerEvent<HTMLElement>) => {
    swallowClick.current = false;
    if (disabled || editing || event.button !== 0) return;
    // Kept from focusing until the press turns out to be a click, so a drag does not open the text.
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const fallback = props.optional ? parseDecimal(props.placeholder) : null;
    scrub.current = { x: event.clientX, base: value ?? fallback ?? 0, moved: false };
  };
  const moveScrub = (event: React.PointerEvent<HTMLElement>) => {
    const s = scrub.current;
    if (!s) return;
    const dx = event.clientX - s.x;
    if (!s.moved && Math.abs(dx) < SCRUB_SLOP_PX) return;
    if (!s.moved) {
      s.moved = true;
      setScrubbing(true);
    }
    const steps = Math.round(dx / SCRUB_PX_PER_STEP);
    const raw = s.base + steps * step * (event.shiftKey ? 10 : 1);
    const folded = normalize ? normalize(raw) : raw;
    commit(roundTo(clamp(folded, min, max), decimals), true);
  };
  const endScrub = () => {
    const s = scrub.current;
    if (!s) return;
    scrub.current = null;
    setScrubbing(false);
    if (s.moved) {
      swallowClick.current = true;
      onScrubEnd?.();
      return;
    }
    inputRef.current?.focus();
    inputRef.current?.select();
  };

  // A button may not sit inside a label; the box needs none of a label's own behaviour anyway.
  const Box = unitSwitch ? "div" : "label";
  return (
    <Box
      ref={boxRef as React.Ref<HTMLLabelElement & HTMLDivElement>}
      className={cx(
        styles.field,
        editing && styles.editing,
        scrubbing && styles.scrubbing,
        disabled && styles.disabled,
        className,
      )}
      title={label}
      onPointerDown={startScrub}
      onPointerMove={moveScrub}
      onPointerUp={endScrub}
      onPointerCancel={endScrub}
      onClick={(e) => {
        if (swallowClick.current) e.preventDefault();
      }}
    >
      {prefix !== undefined && (
        <span className={styles.prefix} aria-hidden="true">
          {prefix}
        </span>
      )}
      <input
        ref={inputRef}
        id={id}
        type="text"
        inputMode="decimal"
        role="spinbutton"
        autoComplete="off"
        spellCheck={false}
        aria-label={label}
        aria-valuenow={value === undefined ? undefined : roundTo(value, decimals)}
        aria-valuemin={Number.isFinite(min) ? min : undefined}
        aria-valuemax={Number.isFinite(max) ? max : undefined}
        aria-valuetext={value === undefined ? undefined : `${format(value)}${unit ? ` ${unit}` : ""}`}
        aria-describedby={describedBy}
        disabled={disabled}
        className={styles.input}
        // As wide as the number: the value sits by its mark and unit instead of across the field.
        // With a unit that switches, room for the widest value, so the switch never moves under the pointer.
        style={{ width: `${Math.max(draft.length, props.optional ? props.placeholder.length : 1, unitSwitch && Number.isFinite(max) ? String(Math.round(max)).length : 1) + 0.5}ch` }}
        value={draft}
        placeholder={props.optional ? props.placeholder : undefined}
        data-testid={testId}
        data-dock-first={first || undefined}
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
      {unit &&
        (unitSwitch ? (
          <button
            type="button"
            className={cx(styles.unit, styles.unitSwitch)}
            aria-label={unitSwitch.label}
            title={unitSwitch.label}
            // Its own press, not the start of a drag across the field.
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.preventDefault();
              unitSwitch.onPress();
            }}
          >
            {unit}
          </button>
        ) : (
          <span className={styles.unit} aria-hidden="true">
            {unit}
          </span>
        ))}
    </Box>
  );
}

/** A line under the fields it explains, aligned with their values. */
export function FieldHint({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <p id={id} className={styles.hint}>
      {children}
    </p>
  );
}
