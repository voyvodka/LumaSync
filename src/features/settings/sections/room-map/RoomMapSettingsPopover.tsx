import { useRef, useEffect, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { RoomDimensions } from "../../../../shared/contracts/roomMap";

/** Numeric input that holds local string state and commits a clamped number on blur/Enter */
function NumericField({
  value,
  min,
  max,
  step,
  onChange,
  className,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  className?: string;
}) {
  const [local, setLocal] = useState(String(value));

  // Sync when external value changes (e.g. undo)
  const prevValue = useRef(value);
  if (prevValue.current !== value) {
    prevValue.current = value;
    setLocal(String(value));
  }

  const commit = useCallback(() => {
    const num = parseFloat(local);
    if (isNaN(num)) {
      setLocal(String(value));
      return;
    }
    const clamped = Math.max(min, Math.min(max, num));
    onChange(clamped);
    setLocal(String(clamped));
  }, [local, value, min, max, onChange]);

  return (
    <input
      type="number"
      min={min}
      max={max}
      step={step}
      value={local}
      onChange={(e) => setLocal(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") commit();
      }}
      className={className}
    />
  );
}

interface RoomMapSettingsPopoverProps {
  open: boolean;
  onClose: () => void;
  dimensions: RoomDimensions;
  showGrid: boolean;
  gridStrokeWidth: number;
  /** v1.5 W4-J #3 — Hue zone bounds visibility toggle. */
  showHueZones: boolean;
  onDimensionsChange: (d: RoomDimensions) => void;
  onGridToggle: (v: boolean) => void;
  onGridStrokeWidthChange: (v: number) => void;
  onHueZonesToggle: (v: boolean) => void;
  onReset: () => void;
}

export function RoomMapSettingsPopover({
  open,
  onClose,
  dimensions,
  showGrid,
  gridStrokeWidth,
  showHueZones,
  onDimensionsChange,
  onGridToggle,
  onGridStrokeWidthChange,
  onHueZonesToggle,
  onReset,
}: RoomMapSettingsPopoverProps) {
  const { t } = useTranslation("common");
  const popoverRef = useRef<HTMLDivElement>(null);
  const [resetConfirming, setResetConfirming] = useState(false);

  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };

    const handleMouseDown = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("mousedown", handleMouseDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("mousedown", handleMouseDown);
    };
  }, [open, onClose]);

  useEffect(() => {
    if (!resetConfirming) return;
    const timer = setTimeout(() => {
      setResetConfirming(false);
    }, 3000);
    return () => clearTimeout(timer);
  }, [resetConfirming]);

  const handleResetClick = () => {
    if (resetConfirming) {
      onReset();
      setResetConfirming(false);
    } else {
      setResetConfirming(true);
    }
  };

  const inputClass =
    "w-full rounded-md border border-[var(--lm-line-2)] bg-[var(--lm-panel-2)] px-2 py-1 text-sm text-[var(--lm-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--lm-amber)]/60";
  const labelClass = "block text-[11px] font-semibold text-[var(--lm-ink-dim)] mb-1";

  return (
    <div
      ref={popoverRef}
      className="absolute top-10 left-0 z-50 w-[280px] rounded-lg border border-[var(--lm-line)] bg-[var(--lm-panel)]/95 shadow-lg p-4"
      role="dialog"
      aria-label={t("roomMap.toolbar.settingsAriaLabel")}
    >
      <div className="flex flex-col gap-3">
        {/* Room Width */}
        <div>
          <label className={labelClass}>
            {t("roomMap.settings.roomWidth")}
          </label>
          <NumericField
            value={dimensions.widthMeters}
            min={1}
            max={30}
            step={0.5}
            onChange={(v) => onDimensionsChange({ ...dimensions, widthMeters: v })}
            className={inputClass}
          />
        </div>

        {/* Room Depth */}
        <div>
          <label className={labelClass}>
            {t("roomMap.settings.roomDepth")}
          </label>
          <NumericField
            value={dimensions.depthMeters}
            min={1}
            max={30}
            step={0.5}
            onChange={(v) => onDimensionsChange({ ...dimensions, depthMeters: v })}
            className={inputClass}
          />
        </div>

        {/* Grid toggle */}
        <div>
          <label className="flex items-center gap-2 cursor-pointer text-sm text-[var(--lm-ink)]">
            <input
              type="checkbox"
              checked={showGrid}
              onChange={() => onGridToggle(!showGrid)}
              className="rounded accent-[var(--lm-ink)]"
            />
            {t("roomMap.settings.showGrid")}
          </label>
          {/* Grid stroke width slider */}
          {showGrid && (
            <div className="mt-2">
              <label className={labelClass}>
                {t("roomMap.settings.gridStrokeWidth")}: {gridStrokeWidth.toFixed(1)}px
              </label>
              <input
                type="range"
                min={0.5}
                max={3}
                step="any"
                value={gridStrokeWidth}
                onChange={(e) => onGridStrokeWidthChange(parseFloat(e.target.value))}
                onPointerUp={(e) => {
                  const raw = parseFloat((e.target as HTMLInputElement).value);
                  onGridStrokeWidthChange(Math.round(raw * 10) / 10);
                }}
                className="w-full accent-[var(--lm-ink)]"
              />
            </div>
          )}
        </div>

        {/* W4-J #3 — Hue zone bounds visibility toggle. Persisted to
            shellStore as `roomMapShowHueZones` so the user's choice
            survives editor reopen. */}
        <div>
          <label className="flex items-center gap-2 cursor-pointer text-sm text-[var(--lm-ink)]">
            <input
              type="checkbox"
              checked={showHueZones}
              onChange={() => onHueZonesToggle(!showHueZones)}
              className="rounded accent-[var(--lm-ink)]"
            />
            {t("roomMap.settings.showHueZones")}
          </label>
          <p className="mt-1 text-[10.5px] leading-snug text-[var(--lm-ink-faint)]">
            {t("roomMap.settings.showHueZonesHint")}
          </p>
        </div>

        {/* Divider */}
        <div className="border-t border-[var(--lm-line)]" />

        {/* Reset map — destructive intent token (kept on red-* utilities) */}
        <div>
          <button
            className={`w-full rounded-md border px-3 py-1.5 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/60 ${
              resetConfirming
                ? "border-red-700 bg-red-950/30 text-red-400"
                : "border-red-800 text-red-400 hover:bg-red-950/20"
            }`}
            onClick={handleResetClick}
          >
            {resetConfirming
              ? t("roomMap.settings.resetMapConfirm")
              : t("roomMap.settings.resetMap")}
          </button>
        </div>
      </div>
    </div>
  );
}
