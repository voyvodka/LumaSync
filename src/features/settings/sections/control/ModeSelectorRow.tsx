import { useTranslation } from "react-i18next";

import {
  LIGHTING_MODE_KIND,
  type LightingModeConfig,
  type LightingModeKind,
} from "../../../mode/model/contracts";

interface ModeSelectorRowProps {
  activeKind: LightingModeKind;
  disabled: boolean;
  ambilightBrightness: number;
  solidDraft: { r: number; g: number; b: number; brightness: number };
  onModeChange: (nextMode: LightingModeConfig) => void;
}

export function ModeSelectorRow({
  activeKind,
  disabled,
  ambilightBrightness,
  solidDraft,
  onModeChange,
}: ModeSelectorRowProps) {
  const { t } = useTranslation("common");

  const isOff = activeKind === LIGHTING_MODE_KIND.OFF;
  const isAmbilight = activeKind === LIGHTING_MODE_KIND.AMBILIGHT;
  const isSolid = activeKind === LIGHTING_MODE_KIND.SOLID;

  const modeModes = [
    {
      kind: LIGHTING_MODE_KIND.AMBILIGHT,
      active: isAmbilight,
      label: t("general.mode.options.ambilight"),
      onClick: () =>
        onModeChange({
          kind: LIGHTING_MODE_KIND.AMBILIGHT,
          ambilight: { brightness: ambilightBrightness },
        }),
    },
    {
      kind: LIGHTING_MODE_KIND.SOLID,
      active: isSolid,
      label: t("general.mode.options.solid"),
      onClick: () =>
        onModeChange({
          kind: LIGHTING_MODE_KIND.SOLID,
          solid: { r: solidDraft.r, g: solidDraft.g, b: solidDraft.b, brightness: solidDraft.brightness },
        }),
    },
  ] as const;

  return (
    <div className="flex items-center gap-3">
      {/* Off — power action, visually separate from mode selection */}
      <button
        type="button"
        disabled={disabled}
        aria-pressed={isOff}
        onClick={() => onModeChange({ kind: LIGHTING_MODE_KIND.OFF })}
        className={`flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/60 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-zinc-900 disabled:opacity-50 ${
          isOff
            ? "border-slate-900 bg-slate-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900"
            : "border-slate-200 bg-transparent text-slate-600 hover:border-slate-400 hover:text-slate-900 dark:border-zinc-700 dark:text-zinc-400 dark:hover:border-zinc-500 dark:hover:text-zinc-200"
        }`}
      >
        <svg viewBox="0 0 14 14" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
          <path d="M7 1v5M4 3.2A5 5 0 107 12a5 5 0 003-1.5" />
        </svg>
        {t("general.mode.options.off")}
      </button>

      {/* Divider */}
      <div className="h-6 w-px bg-slate-200 dark:bg-zinc-700" aria-hidden />

      {/* Mode selection */}
      <div className="flex gap-2">
        {modeModes.map(({ kind, active, label, onClick }) => (
          <button
            key={kind}
            type="button"
            disabled={disabled}
            aria-pressed={active}
            onClick={onClick}
            className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/60 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-zinc-900 disabled:opacity-50 ${
              active
                ? "bg-slate-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                : "bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
            }`}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
