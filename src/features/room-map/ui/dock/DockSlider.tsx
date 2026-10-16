import type { ReactNode } from "react";

import { cx } from "@/shared/lib/cx";

import styles from "./DockSlider.module.css";

/** A slider on one dock row: a small mark, the track, and the value it stands at. */
export function DockSlider({
  label,
  prefix,
  min,
  max,
  step,
  value,
  onChange,
  onCommit,
  readout,
  ariaValueText,
  disabled = false,
  className,
  testId,
}: {
  label: string;
  prefix?: ReactNode;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (value: number) => void;
  /** Where it is let go: the pointer up or cancelled, a key up, or focus leaving. */
  onCommit?: (value: number) => void;
  /** The value as the row shows it, unit included. */
  readout: string;
  /** What a screen reader says for the value when the raw number names nothing. */
  ariaValueText?: string;
  disabled?: boolean;
  className?: string;
  testId?: string;
}) {
  const fill = max > min ? ((value - min) / (max - min)) * 100 : 0;
  return (
    <label className={cx(styles.slider, disabled && styles.disabled, className)} title={label}>
      {prefix !== undefined && (
        <span className={styles.prefix} aria-hidden="true">
          {prefix}
        </span>
      )}
      <input
        type="range"
        className={styles.input}
        style={{ "--fill": `${fill}%` } as React.CSSProperties}
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={Math.round(value * 100) / 100}
        aria-valuetext={ariaValueText}
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        data-testid={testId}
        onChange={(e) => onChange(Number(e.target.value))}
        onPointerUp={onCommit && ((e) => onCommit(Number(e.currentTarget.value)))}
        onPointerCancel={onCommit && ((e) => onCommit(Number(e.currentTarget.value)))}
        onKeyUp={onCommit && ((e) => onCommit(Number(e.currentTarget.value)))}
        onBlur={onCommit && ((e) => onCommit(Number(e.currentTarget.value)))}
      />
      <span className={styles.readout} aria-hidden="true">
        {readout}
      </span>
    </label>
  );
}
