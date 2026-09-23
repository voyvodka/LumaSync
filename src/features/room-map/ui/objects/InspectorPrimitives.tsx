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
 * `InspectorNumberField` for a value that may be absent. Empty means "use the
 * default", which the placeholder shows; clearing commits `undefined`. A blur
 * that changed nothing does not commit, so focusing an empty field never
 * writes the default into storage.
 */
export function InspectorOptionalNumberField({
  id,
  label,
  value,
  placeholder,
  step = 0.05,
  min,
  max,
  unit,
  disabled,
  describedBy,
  onCommit,
}: {
  id: string;
  label: string;
  value: number | undefined;
  placeholder: string;
  step?: number;
  min: number;
  max: number;
  unit?: string;
  disabled?: boolean;
  describedBy?: string;
  onCommit: (next: number | undefined) => void;
}) {
  const format = (v: number | undefined) => (v === undefined ? "" : v.toFixed(2));
  const [local, setLocal] = useState(format(value));
  const [editing, setEditing] = useState(false);

  if (!editing && local !== format(value)) {
    setLocal(format(value));
  }

  const commit = () => {
    setEditing(false);
    const trimmed = local.trim();
    if (trimmed === "") {
      if (value !== undefined) onCommit(undefined);
      return;
    }
    const num = parseFloat(trimmed);
    if (Number.isNaN(num)) {
      setLocal(format(value));
      return;
    }
    const clamped = Math.min(max, Math.max(min, num));
    if (clamped === value) {
      setLocal(format(value));
      return;
    }
    onCommit(clamped);
  };

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
        placeholder={placeholder}
        aria-describedby={describedBy}
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
            setLocal(format(value));
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
 * `HueZoneInspector` (the reference layout). The chip label is the
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
