import { useRef, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { RoomDimensions } from "../../../../shared/contracts/roomMap";

interface RoomMapSettingsPopoverProps {
  open: boolean;
  onClose: () => void;
  dimensions: RoomDimensions;
  showGrid: boolean;
  backgroundOpacity: number;
  backgroundFileName: string | null;
  onDimensionsChange: (d: RoomDimensions) => void;
  onGridToggle: (v: boolean) => void;
  onOpacityChange: (v: number) => void;
  onUploadBackground: () => void;
  onReset: () => void;
}

export function RoomMapSettingsPopover({
  open,
  onClose,
  dimensions,
  showGrid,
  backgroundOpacity,
  backgroundFileName,
  onDimensionsChange,
  onGridToggle,
  onOpacityChange,
  onUploadBackground,
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
    "w-full rounded-md border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-2 py-1 text-sm text-slate-900 dark:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/60";
  const labelClass = "block text-[11px] font-semibold text-slate-600 dark:text-zinc-400 mb-1";

  return (
    <div
      ref={popoverRef}
      className="absolute top-10 left-0 z-50 w-[280px] rounded-lg border border-slate-200/70 dark:border-zinc-800 bg-white/95 dark:bg-zinc-900/95 shadow-lg p-4"
      role="dialog"
      aria-label={t("roomMap.toolbar.settingsAriaLabel")}
    >
      <div className="flex flex-col gap-3">
        {/* Room Width */}
        <div>
          <label className={labelClass}>
            {t("roomMap.settings.roomWidth")}
          </label>
          <input
            type="number"
            min={1}
            max={30}
            step={0.5}
            value={dimensions.widthMeters}
            onChange={(e) =>
              onDimensionsChange({
                ...dimensions,
                widthMeters: parseFloat(e.target.value) || 1,
              })
            }
            className={inputClass}
          />
        </div>

        {/* Room Depth */}
        <div>
          <label className={labelClass}>
            {t("roomMap.settings.roomDepth")}
          </label>
          <input
            type="number"
            min={1}
            max={30}
            step={0.5}
            value={dimensions.depthMeters}
            onChange={(e) =>
              onDimensionsChange({
                ...dimensions,
                depthMeters: parseFloat(e.target.value) || 1,
              })
            }
            className={inputClass}
          />
        </div>

        {/* Background section */}
        <div>
          <span className={labelClass}>
            {t("roomMap.settings.uploadBackground")}
          </span>
          <button
            className="w-full rounded-md border border-slate-200/70 dark:border-zinc-700 px-3 py-1.5 text-sm text-slate-700 dark:text-zinc-300 hover:bg-slate-50 dark:hover:bg-zinc-800 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/60"
            onClick={onUploadBackground}
          >
            {t("roomMap.settings.uploadBackground")}
          </button>
          {backgroundFileName && (
            <p className="mt-1 text-[10px] text-slate-400 dark:text-zinc-500 truncate">
              {backgroundFileName}
            </p>
          )}
          {/* Opacity slider */}
          {backgroundFileName && (
            <div className="mt-2">
              <label className={labelClass}>
                {t("roomMap.settings.opacity")}: {backgroundOpacity}%
              </label>
              <input
                type="range"
                min={0}
                max={100}
                value={backgroundOpacity}
                onChange={(e) => onOpacityChange(parseInt(e.target.value, 10))}
                className="w-full accent-slate-700 dark:accent-zinc-300"
              />
            </div>
          )}
        </div>

        {/* Grid toggle */}
        <div>
          <label className="flex items-center gap-2 cursor-pointer text-sm text-slate-700 dark:text-zinc-300">
            <input
              type="checkbox"
              checked={showGrid}
              onChange={() => onGridToggle(!showGrid)}
              className="rounded accent-slate-700 dark:accent-zinc-300"
            />
            {t("roomMap.settings.showGrid")}
          </label>
        </div>

        {/* Divider */}
        <div className="border-t border-slate-200/70 dark:border-zinc-800" />

        {/* Reset map */}
        <div>
          <button
            className={`w-full rounded-md border px-3 py-1.5 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/60 ${
              resetConfirming
                ? "border-red-400 bg-red-50 text-red-600 dark:bg-red-950/30 dark:border-red-700 dark:text-red-400"
                : "border-red-300 dark:border-red-800 text-red-500 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/20"
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
