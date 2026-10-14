import { useRef, useEffect, useState, useId } from "react";
import { useTranslation } from "react-i18next";
import { DEFAULT_ROOM_DIMENSIONS, type RoomDimensions } from "@/shared/contracts/roomMap";
import { DecimalField } from "./DecimalField";
import { GlyphDepth, GlyphHeight, GlyphWidth } from "./objects/fieldGlyphs";

/** A low basement to a double-height room. */
export const ROOM_HEIGHT_MIN_M = 1.5;
export const ROOM_HEIGHT_MAX_M = 8;

interface RoomMapSettingsPopoverProps {
  open: boolean;
  onClose: () => void;
  dimensions: RoomDimensions;
  showGrid: boolean;
  gridStrokeWidth: number;
  /** Hue zone bounds visibility toggle. */
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
  const { t } = useTranslation();
  const popoverRef = useRef<HTMLDivElement>(null);
  const [resetConfirming, setResetConfirming] = useState(false);
  const fieldId = useId();

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

  const labelClass = "block text-[11px] font-semibold text-ink-dim mb-1";

  return (
    <div
      ref={popoverRef}
      className="absolute top-10 left-0 z-50 w-[280px] rounded-lg border border-line bg-panel/95 shadow-lg p-4"
      role="dialog"
      aria-label={t("roomMap:toolbar.settingsAriaLabel")}
    >
      <div className="flex flex-col gap-3">
        {/* Room Width */}
        <div>
          <label className={labelClass} htmlFor={`${fieldId}-width`}>
            {t("roomMap:settings.roomWidth")}
          </label>
          <DecimalField
            id={`${fieldId}-width`}
            label={t("roomMap:settings.roomWidth")}
            prefix={<GlyphWidth />}
            value={dimensions.widthMeters}
            min={1}
            max={30}
            step={0.5}
            unit="m"
            onCommit={(v) => onDimensionsChange({ ...dimensions, widthMeters: v })}
          />
        </div>

        {/* Room Depth */}
        <div>
          <label className={labelClass} htmlFor={`${fieldId}-depth`}>
            {t("roomMap:settings.roomDepth")}
          </label>
          <DecimalField
            id={`${fieldId}-depth`}
            label={t("roomMap:settings.roomDepth")}
            prefix={<GlyphDepth />}
            value={dimensions.depthMeters}
            min={1}
            max={30}
            step={0.5}
            unit="m"
            onCommit={(v) => onDimensionsChange({ ...dimensions, depthMeters: v })}
          />
        </div>

        {/* Room Height — drives Hue vertical sampling and every height readout. */}
        <div>
          <label className={labelClass} htmlFor={`${fieldId}-height`}>
            {t("roomMap:settings.roomHeight")}
          </label>
          <DecimalField
            id={`${fieldId}-height`}
            label={t("roomMap:settings.roomHeight")}
            prefix={<GlyphHeight />}
            value={dimensions.heightMeters ?? DEFAULT_ROOM_DIMENSIONS.heightMeters}
            min={ROOM_HEIGHT_MIN_M}
            max={ROOM_HEIGHT_MAX_M}
            step={0.1}
            unit="m"
            describedBy={`${fieldId}-height-hint`}
            onCommit={(v) => onDimensionsChange({ ...dimensions, heightMeters: v })}
          />
          <p id={`${fieldId}-height-hint`} className="mt-1 text-[10.5px] leading-snug text-ink-faint">
            {t("roomMap:settings.roomHeightHint")}
          </p>
        </div>

        {/* Grid toggle */}
        <div>
          <label className="flex items-center gap-2 cursor-pointer text-sm text-ink">
            <input
              type="checkbox"
              checked={showGrid}
              onChange={() => onGridToggle(!showGrid)}
              className="rounded accent-ink"
            />
            {t("roomMap:settings.showGrid")}
          </label>
          {/* Grid stroke width slider */}
          {showGrid && (
            <div className="mt-2">
              <label className={labelClass} htmlFor={`${fieldId}-stroke`}>
                {t("roomMap:settings.gridStrokeWidth")}: {gridStrokeWidth.toFixed(1)}px
              </label>
              <input
                id={`${fieldId}-stroke`}
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
                className="w-full accent-ink"
              />
            </div>
          )}
        </div>

        {/* Hue zone bounds visibility toggle. Persisted to
            shellStore as `roomMapShowHueZones` so the user's choice
            survives editor reopen. */}
        <div>
          <label className="flex items-center gap-2 cursor-pointer text-sm text-ink">
            <input
              type="checkbox"
              checked={showHueZones}
              onChange={() => onHueZonesToggle(!showHueZones)}
              className="rounded accent-ink"
            />
            {t("roomMap:settings.showHueZones")}
          </label>
          <p className="mt-1 text-[10.5px] leading-snug text-ink-faint">
            {t("roomMap:settings.showHueZonesHint")}
          </p>
        </div>

        {/* Divider */}
        <div className="border-t border-line" />

        {/* Reset map — destructive intent token (kept on red-* utilities) */}
        <div>
          <button
            className={`w-full rounded-md border px-3 py-1.5 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/60 ${
              resetConfirming
                ? "border-red-700 bg-red-950/30 text-red-400"
                : "border-red-800 text-red-400 hover:bg-red-950/20"
            }`}
            onClick={handleResetClick}
            aria-describedby={`${fieldId}-reset-hint`}
          >
            {resetConfirming
              ? t("roomMap:settings.resetMapConfirm")
              : t("roomMap:settings.resetMap")}
          </button>
          <p id={`${fieldId}-reset-hint`} className="mt-1 text-[10.5px] leading-snug text-ink-faint">
            {t("roomMap:settings.resetMapHint")}
          </p>
        </div>
      </div>
    </div>
  );
}
