import { useId, type CSSProperties, type ReactNode } from "react";

import { cx } from "./cx";

export type RangeRowVariant = "profile" | "compact" | "dock";

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
  const percent = max > min ? ((value - min) / (max - min)) * 100 : 0;

  const input = (extra: { className?: string; style?: CSSProperties; id?: string }) => (
    <input
      type="range"
      id={extra.id}
      min={min}
      max={max}
      step={step}
      value={value}
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
      onPointerDown={onDragStart}
      onPointerUp={onDragEnd}
      onPointerCancel={onDragEnd}
      onChange={(event) => {
        const next = Number(event.currentTarget.value);
        if (Number.isFinite(next)) onChange(next);
      }}
    />
  );

  if (variant === "profile") {
    return (
      <div className={cx("lm-psl", className)}>
        <div className="row">
          <span>{label}</span>
          <b>{valueLabel}</b>
        </div>
        <div className="tr">
          <div className="tr-track">
            <span className="tr-fill" style={{ width: `${percent}%` }} />
          </div>
          {input({})}
        </div>
      </div>
    );
  }

  if (variant === "compact") {
    return (
      <div className={cx("lm-compact-slider-row", className)}>
        <div className="srow">
          <span>{label}</span>
          <b>{valueLabel}</b>
        </div>
        {/* `--lm-fill` drives the track gradient, so the amber grows with the thumb. */}
        {input({
          className: "lm-compact-slider",
          style: { ["--lm-fill" as string]: `${percent}%` } as CSSProperties,
        })}
        {note && (
          <div className="lm-compact-brightness-note" role="note">
            {note}
          </div>
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
