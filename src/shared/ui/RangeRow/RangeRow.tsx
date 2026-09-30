import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

import { cx } from "@/shared/lib/cx";
import { prefersReducedMotion } from "@/shared/lib/motion";
import styles from "./RangeRow.module.css";

export type RangeRowVariant = "stage" | "dock";

/** An outside change's glide: the stage's base duration, a little longer for the distance. */
const GLIDE_MS = 240;
/**
 * How long the user's own value outlives their last move when the value given back has not caught
 * up: a drag commits faster than the lights answer, and what comes back meanwhile is behind it.
 */
const SETTLE_MS = 1200;
/** How near the default, as a share of the range, a pointer drag lets go into it. */
const DETENT_SHARE = 0.02;

/** A readout or spoken value that follows the thumb: given the value on show. */
type ValueText<T> = T | ((value: number) => T);

interface RangeRowProps {
  /** `profile` is the Lights page's signal rows, `compact` the tray window's, `dock` the room-map inspector's. */
  variant: RangeRowVariant;
  label: string;
  /** A function is given the value on show, so the readout follows a drag the value has not caught up with. */
  valueLabel: ValueText<ReactNode>;
  value: number;
  min: number;
  max: number;
  step: number | "any";
  onChange: (value: number) => void;
  disabled?: boolean;
  /** Defaults to `label`. */
  ariaLabel?: string;
  /** Read aloud instead of the raw number, when the number means nothing on its own. */
  ariaValueText?: ValueText<string>;
  title?: string;
  /** Shown under a `compact` row — why it is locked. */
  note?: string;
  className?: string;
  /** Drag bracketing, for a caller that must not take outside updates mid-drag. */
  onDragStart?: () => void;
  onDragEnd?: () => void;
  /**
   * A neutral value off the track's ends (saturation's 100%): marked on the track, a pointer drag
   * settles into it near by, and the readout takes it back there. `label` names that press.
   */
  neutral?: { value: number; label: string };
  /** A CSS background for the track in place of the amber fill — Solid's whites. Stage only. */
  track?: string;
  testId?: string;
}

const resolve = <T,>(text: ValueText<T>, value: number): T =>
  typeof text === "function" ? (text as (value: number) => T)(value) : text;

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
  neutral,
  track,
  testId,
}: RangeRowProps) {
  const id = useId();

  // The user's own value, held while they set it and until the value given back catches up. What
  // comes back meanwhile is behind the pointer — a drag outruns the lights — and taken as it came it
  // pulled the thumb back and shook the readout.
  const [held, setHeld] = useState<number | null>(null);
  const pressed = useRef(false);
  const settle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const letGo = () => {
    clearTimeout(settle.current);
    settle.current = setTimeout(() => setHeld(null), SETTLE_MS);
  };
  useEffect(() => () => clearTimeout(settle.current), []);
  // Caught up: nothing left to hold.
  if (held !== null && !pressed.current && value === held) setHeld(null);

  // A value set from outside — another effect's default, a scene — glides there, and its readout
  // and a new name fade in. The glide is state, not a write to the input: React puts a controlled
  // input back on any render in between.
  const [glide, setGlide] = useState<number | null>(null);
  const target = useRef(value);
  const displayed = useRef(value);
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
    if (held !== null) {
      // The user's: nothing glides under their hand, and the readout does not come in anew.
      target.current = value;
      displayed.current = held;
      return;
    }
    if (target.current === value && displayed.current === value) return;
    target.current = value;
    // From wherever the thumb was: an unfinished glide, or the user's value let go.
    const from = displayed.current;
    cancelAnimationFrame(frame.current);
    if (from === value) return;
    setReadout((n) => n + 1);
    if (variant !== "stage" || prefersReducedMotion()) {
      displayed.current = value;
      setGlide(null);
      return;
    }
    // Painted from where it was, not a frame at the new value first.
    setGlide(from);
    const start = performance.now();
    // The clock read here, not the frame's timestamp, which some runtimes keep on another clock.
    const tick = () => {
      const t = Math.min(1, (performance.now() - start) / GLIDE_MS);
      displayed.current = t === 1 ? value : from + (value - from) * (1 - (1 - t) ** 3);
      setGlide(t === 1 ? null : displayed.current);
      if (t < 1) frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
  }, [value, held, variant]);
  useLayoutEffect(() => () => cancelAnimationFrame(frame.current), []);

  const shown = held ?? glide ?? value;
  const share = (v: number) => (max > min ? (v - min) / (max - min) : 0);
  const readoutText = resolve(valueLabel, shown);
  const atNeutral = neutral !== undefined && Math.round(shown) === neutral.value;

  const input = (extra: { className?: string; style?: CSSProperties; id?: string }) => (
    <input
      type="range"
      id={extra.id}
      min={min}
      max={max}
      step={step}
      value={shown}
      disabled={disabled}
      aria-disabled={disabled || undefined}
      aria-label={ariaLabel ?? label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.round(shown * 100) / 100}
      aria-valuetext={ariaValueText === undefined ? undefined : resolve(ariaValueText, shown)}
      title={title}
      className={extra.className}
      style={extra.style}
      data-testid={testId}
      onPointerDown={() => {
        pressed.current = true;
        clearTimeout(settle.current);
        // A thumb caught mid-glide is where the value is.
        if (glide !== null) stopGlide();
        onDragStart?.();
      }}
      onPointerUp={() => {
        pressed.current = false;
        letGo();
        onDragEnd?.();
      }}
      onPointerCancel={() => {
        pressed.current = false;
        letGo();
        onDragEnd?.();
      }}
      onChange={(event) => {
        let next = Number(event.currentTarget.value);
        if (!Number.isFinite(next)) return;
        // Only a pointer settles into the neutral value: the arrow keys must be able to step off it.
        if (neutral && pressed.current && Math.abs(next - neutral.value) <= (max - min) * DETENT_SHARE) {
          next = neutral.value;
        }
        if (glide !== null) stopGlide();
        // Where the thumb is now, for whatever follows: the hold can end in the same render as the
        // value catches up, before its effect has run.
        displayed.current = next;
        setHeld(next);
        if (!pressed.current) letGo();
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
          {neutral && !atNeutral && !disabled ? (
            <button
              key={readout}
              type="button"
              className={cx(styles.value, styles.toNeutral)}
              data-swapped={readout > 0 || undefined}
              title={neutral.label}
              aria-label={neutral.label}
              onClick={() => onChange(neutral.value)}
              data-testid={testId ? `${testId}-neutral` : undefined}
            >
              {readoutText}
            </button>
          ) : (
            <span key={readout} className={styles.value} data-swapped={readout > 0 || undefined}>
              {readoutText}
            </span>
          )}
        </div>
        <div className={styles.trackBox}>
          {/* `--fill` drives the track, so the amber grows with the thumb. */}
          {input({
            className: cx(styles.slider, track && styles.whites),
            style: {
              ["--fill" as string]: `${share(shown) * 100}%`,
              ...(track ? { ["--track" as string]: track } : {}),
            } as CSSProperties,
          })}
          {neutral && !atNeutral ? (
            <span className={styles.tick} style={{ ["--at" as string]: share(neutral.value) } as CSSProperties} aria-hidden />
          ) : null}
        </div>
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
      <span className="lm-room-dock-field-value">{readoutText}</span>
    </div>
  );
}
