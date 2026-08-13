import { useCallback, useState } from "react";

/**
 * Inline number input shared by all inspectors. Behaves like the
 * PropertyBar's `NumberInput` (commit on blur / Enter, reverts on
 * invalid parse) but visually tuned for the dock — denser typography,
 * mono caps label aligned with `lm-room-dock-field-label`.
 */
export function InspectorNumberField({
  id,
  label,
  value,
  step = 0.1,
  min,
  max,
  unit,
  disabled,
  onCommit,
}: {
  id: string;
  label: string;
  value: number;
  step?: number;
  min?: number;
  max?: number;
  unit?: string;
  disabled?: boolean;
  onCommit: (next: number) => void;
}) {
  const [local, setLocal] = useState(value.toFixed(step >= 1 ? 0 : 2));
  const [editing, setEditing] = useState(false);

  if (!editing && local !== value.toFixed(step >= 1 ? 0 : 2)) {
    // Sync external updates while not actively editing — same pattern
    // PropertyBar uses to avoid clobbering an in-flight typed value.
    setLocal(value.toFixed(step >= 1 ? 0 : 2));
  }

  const commit = useCallback(() => {
    setEditing(false);
    const num = parseFloat(local);
    if (Number.isNaN(num)) {
      setLocal(value.toFixed(step >= 1 ? 0 : 2));
      return;
    }
    let clamped = num;
    if (typeof min === "number") clamped = Math.max(min, clamped);
    if (typeof max === "number") clamped = Math.min(max, clamped);
    onCommit(clamped);
  }, [local, max, min, onCommit, step, value]);

  return (
    <div className="lm-room-dock-field">
      <label className="lm-room-dock-field-label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        type="number"
        step={step}
        min={min}
        max={max}
        disabled={disabled}
        className="lm-room-dock-input"
        value={local}
        onFocus={() => setEditing(true)}
        onChange={(e) => {
          setEditing(true);
          setLocal(e.target.value);
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            setLocal(value.toFixed(step >= 1 ? 0 : 2));
            setEditing(false);
          }
        }}
      />
      {unit ? <span className="lm-room-dock-field-unit">{unit}</span> : null}
    </div>
  );
}

/**
 * `Header` is shared by every inspector so the visual rhythm matches
 * `HueZoneInspector` (the W4-C reference). The chip label is the
 * machine-readable type (translated) and `name` is the user-facing
 * label of the selected object.
 */
export function Header({
  typeLabel,
  name,
  dotColor,
}: {
  typeLabel: string;
  name: string;
  dotColor: string;
}) {
  return (
    <div className="lm-room-dock-inspect-h">
      <span className="lm-room-dock-inspect-h-chip">
        <span
          className="lm-room-dock-inspect-h-chip-dot"
          style={{ background: dotColor }}
          aria-hidden
        />
        <span>{typeLabel}</span>
      </span>
      <span className="sub" title={name}>
        {name}
      </span>
    </div>
  );
}
