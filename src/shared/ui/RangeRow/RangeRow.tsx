import { useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

import { cx } from "@/shared/lib/cx";
import { prefersReducedMotion } from "@/shared/lib/motion";
import styles from "./RangeRow.module.css";

export type RangeRowVariant = "stage" | "dock";

/** An outside change's glide: the stage's base duration, a little longer for the distance. */
const GLIDE_MS = 240;

interface RangeRowProps {
  /** `profile` is the Lights page's signal rows, `compact` the tray window's, `dock` the room-map inspector's. */
  variant: RangeRowVariant;
  label: string;
  valueLabel: ReactNode;
  value: number;
  min: number;
  max: number;
  step: number | "any";
  onChange: (value: number) => void;
  disabled?: boolean;
  /** Defaults to `label`. */
  ariaLabel?: string;
  /** Read aloud instead of the raw number, when the number means nothing on its own. */
  ariaValueText?: string;
  title?: string;
  /** Shown under a `compact` row — why it is locked. */
  note?: string;
  className?: string;
  /** Drag bracketing, for a caller that must not take outside updates mid-drag. */
  onDragStart?: () => void;
  onDragEnd?: () => void;
  testId?: string;
}

/** A labelled slider with its readout, in one of the app's three slider looks. */
export function RangeRow({
  variant,
  label,
  valueLabel,
  value,
  min,
  max,
  step,
  onChange,
  disabled = false,
  ariaLabel,
  ariaValueText,
  title,
  note,
  className,
  onDragStart,
  onDragEnd,
  testId,
}: RangeRowProps) {
  const id = useId();
  // A value set from outside — another effect's default, a scene — glides there, and its readout
  // and a new name fade in; one the user drags follows the pointer untouched. The glide is state,
  // not a write to the input: React puts a controlled input back on any render in between.
  const [glide, setGlide] = useState<number | null>(null);
  const shownValue = glide ?? value;
  const percent = max > min ? ((shownValue - min) / (max - min)) * 100 : 0;
  const target = useRef(value);
  const displayed = useRef(value);
  const dragged = useRef<number | null>(null);
  const frame = useRef(0);
  const [readout, setReadout] = useState(0);
  const named = useRef({ label, renamed: false });
  if (named.current.label !== label) named.current = { label, renamed: true };
  const stopGlide = () => {
    cancelAnimationFrame(frame.current);
    displayed.current = target.current;
    setGlide(null);
  };
  useLayoutEffect(() => {
    if (target.current === value) return;
    target.current = value;
    const own = dragged.current === value;
    dragged.current = null;
    if (own) {
      displayed.current = value;
      return;
    }
    setReadout((n) => n + 1);
    // From wherever an unfinished glide had got to.
    const from = displayed.current;
    cancelAnimationFrame(frame.current);
    if (variant !== "stage" || prefersReducedMotion()) {
      displayed.current = value;
      setGlide(null);
      return;
    }
    // Painted from where it was, not a frame at the new value first.
    setGlide(from);
    const start = performance.now();
    // The clock read here, not the frame's timestamp, which some runtimes keep on another clock.
    const step = () => {
      const t = Math.min(1, (performance.now() - start) / GLIDE_MS);
      displayed.current = t === 1 ? value : from + (value - from) * (1 - (1 - t) ** 3);
      setGlide(t === 1 ? null : displayed.current);
      if (t < 1) frame.current = requestAnimationFrame(step);
    };
    frame.current = requestAnimationFrame(step);
  }, [value, variant]);
  useLayoutEffect(() => () => cancelAnimationFrame(frame.current), []);

  const input = (extra: { className?: string; style?: CSSProperties; id?: string }) => (
    <input
      type="range"
      id={extra.id}
      min={min}
      max={max}
      step={step}
      value={shownValue}
      disabled={disabled}
      aria-disabled={disabled || undefined}
      aria-label={ariaLabel ?? label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.round(value * 100) / 100}
      aria-valuetext={ariaValueText}
      title={title}
      className={extra.className}
      style={extra.style}
      data-testid={testId}
      onPointerDown={() => {
        // A thumb caught mid-glide is where the value is.
        if (glide !== null) stopGlide();
        onDragStart?.();
      }}
      onPointerUp={onDragEnd}
      onPointerCancel={onDragEnd}
      onChange={(event) => {
        const next = Number(event.currentTarget.value);
        if (!Number.isFinite(next)) return;
        dragged.current = next;
        if (glide !== null) stopGlide();
        onChange(next);
      }}
    />
  );

  if (variant === "stage") {
    return (
      <div className={cx(styles.stage, className)}>
        <div className={styles.head}>
          <span key={label} className={styles.label} data-swapped={named.current.renamed || undefined}>
            {label}
          </span>
          <span key={readout} className={styles.value} data-swapped={readout > 0 || undefined}>
            {valueLabel}
          </span>
        </div>
        {/* `--fill` drives the track, so the amber grows with the thumb. */}
        {input({ className: styles.slider, style: { ["--fill" as string]: `${percent}%` } as CSSProperties })}
        {note && (
          <p className={styles.note} role="note">
            {note}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className={cx("lm-room-dock-field", className)}>
      <label className="lm-room-dock-field-label" htmlFor={id}>
        {label}
      </label>
      {input({ id, className: "lm-room-dock-slider" })}
      <span className="lm-room-dock-field-value">{valueLabel}</span>
    </div>
  );
}
