import { useTranslation } from "react-i18next";

import { HsvColorPicker } from "../../../../shared/ui/HsvColorPicker";
import { useSolidColorDraft } from "./useSolidColorDraft";

function toHexPair(value: number): string {
  return Math.max(0, Math.min(255, Math.floor(value))).toString(16).padStart(2, "0");
}

function toHexColor(draft: { r: number; g: number; b: number }): string {
  return `#${toHexPair(draft.r)}${toHexPair(draft.g)}${toHexPair(draft.b)}`;
}

function parseHexColor(value: string): { r: number; g: number; b: number } {
  const safe = value.startsWith("#") ? value.slice(1) : value;
  if (!/^[0-9a-fA-F]{6}$/.test(safe)) return { r: 255, g: 255, b: 255 };
  return {
    r: Number.parseInt(safe.slice(0, 2), 16),
    g: Number.parseInt(safe.slice(2, 4), 16),
    b: Number.parseInt(safe.slice(4, 6), 16),
  };
}

interface SolidColorPanelProps {
  incoming: { r: number; g: number; b: number; brightness: number };
  disabled: boolean;
  /**
   * When true, the brightness slider is locked with an explanatory notice.
   * Used by the Adalight firmware profile (v1.4 G11 / D2 decision): the
   * Adalight wire format does not carry a brightness byte, so any UI-level
   * brightness adjustment would silently no-op. We visibly lock the slider
   * and surface the `brightnessDisabledTooltip` copy instead so the user
   * knows the control is firmware-gated rather than broken.
   */
  brightnessDisabled?: boolean;
  /** Tooltip / notice shown next to the brightness slider when locked. */
  brightnessDisabledReason?: string;
  onCommit: (draft: { r: number; g: number; b: number; brightness: number }) => void;
}

export function SolidColorPanel({
  incoming,
  disabled,
  brightnessDisabled = false,
  brightnessDisabledReason,
  onCommit,
}: SolidColorPanelProps) {
  const { t } = useTranslation("common");
  const { draft, setColor, setBrightness } = useSolidColorDraft({ incoming, onCommit });

  const hexColor = toHexColor(draft);
  const brightnessPercent = Math.round(draft.brightness * 100);
  const solidActiveAlpha = (0.3 + draft.brightness * 0.7).toFixed(3);
  const trackColor = `rgba(${draft.r}, ${draft.g}, ${draft.b}, ${solidActiveAlpha})`;
  const trackRemainder = `rgba(${draft.r}, ${draft.g}, ${draft.b}, 0.18)`;

  const brightnessLocked = brightnessDisabled || disabled;

  return (
    <div className="space-y-4">
      {/* Color picker row */}
      <div>
        <p className="mb-2 text-xs font-medium text-slate-600 dark:text-zinc-300">
          {t("general.mode.solidColor")}
          <span className="ml-2 [font-family:var(--lm-mono)] text-zinc-100">
            {hexColor.toUpperCase()}
          </span>
        </p>
        <div
          className="flex items-center gap-3 rounded-lg border border-slate-200 px-3 py-2.5 dark:border-zinc-700"
          style={{
            background: `linear-gradient(135deg, rgba(${draft.r}, ${draft.g}, ${draft.b}, 0.18) 0%, transparent 100%)`,
          }}
        >
          <HsvColorPicker
            value={hexColor}
            onChange={(hex) => setColor(parseHexColor(hex))}
            disabled={disabled}
            ariaLabel={t("general.mode.solidColor")}
          />
          <div className="min-w-0">
            <p className="text-xs font-medium text-slate-800 dark:text-zinc-100">
              {t("general.mode.colorModelRgb")}
            </p>
            <p className="text-xs tabular-nums text-slate-500 dark:text-zinc-400">
              {draft.r}, {draft.g}, {draft.b}
            </p>
          </div>
        </div>
      </div>

      {/* Brightness slider — full width */}
      <div>
        <p className="mb-2 flex items-center justify-between text-xs font-medium text-slate-600 dark:text-zinc-300">
          <span>{t("general.mode.brightness")}</span>
          <span className="tabular-nums text-zinc-100">
            {brightnessPercent}%
          </span>
        </p>
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          disabled={brightnessLocked}
          aria-label={t("general.mode.brightness")}
          aria-disabled={brightnessLocked}
          title={brightnessDisabled ? brightnessDisabledReason : undefined}
          value={brightnessPercent}
          className="h-2 w-full cursor-pointer appearance-none rounded-full disabled:cursor-not-allowed disabled:opacity-60"
          style={{
            accentColor: trackColor,
            background: `linear-gradient(to right, ${trackColor} 0%, ${trackColor} ${brightnessPercent}%, ${trackRemainder} ${brightnessPercent}%, ${trackRemainder} 100%)`,
          }}
          onChange={(e) => setBrightness(Number.parseInt(e.currentTarget.value, 10) / 100)}
        />
        <div className="mt-1.5 flex justify-between text-[10px] text-slate-400 dark:text-zinc-500">
          <span>0%</span>
          <span>100%</span>
        </div>
        {brightnessDisabled && brightnessDisabledReason && (
          <div
            className="mt-2 [font-family:var(--lm-mono)] text-[10px] leading-snug text-amber-300/80"
            role="note"
          >
            {brightnessDisabledReason}
          </div>
        )}
      </div>
    </div>
  );
}
