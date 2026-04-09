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

  const solidDotColor = `rgb(${solidDraft.r}, ${solidDraft.g}, ${solidDraft.b})`;

  const modes = [
    {
      kind: LIGHTING_MODE_KIND.OFF,
      label: t("general.mode.options.off"),
      icon: (
        <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <path d="M12 2v6M8.5 4.5A8 8 0 1015.5 4.5" />
        </svg>
      ),
      onClick: () => onModeChange({ kind: LIGHTING_MODE_KIND.OFF }),
    },
    {
      kind: LIGHTING_MODE_KIND.AMBILIGHT,
      label: t("general.mode.options.ambilight"),
      icon: (
        <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 3L13.5 8.5L19 9L14.5 13L16 18.5L12 15.5L8 18.5L9.5 13L5 9L10.5 8.5L12 3Z" />
        </svg>
      ),
      onClick: () =>
        onModeChange({
          kind: LIGHTING_MODE_KIND.AMBILIGHT,
          ambilight: { brightness: ambilightBrightness },
        }),
    },
    {
      kind: LIGHTING_MODE_KIND.SOLID,
      label: t("general.mode.options.solid"),
      icon: (
        <div
          className="h-6 w-6 rounded-full border border-slate-200 dark:border-zinc-600"
          style={{ background: solidDotColor }}
        />
      ),
      onClick: () =>
        onModeChange({
          kind: LIGHTING_MODE_KIND.SOLID,
          solid: { r: solidDraft.r, g: solidDraft.g, b: solidDraft.b, brightness: solidDraft.brightness },
        }),
    },
  ] as const;

  return (
    <div className="grid grid-cols-3 gap-3">
      {modes.map(({ kind, label, icon, onClick }) => {
        const isActive = activeKind === kind;
        return (
          <button
            key={kind}
            type="button"
            disabled={disabled}
            aria-pressed={isActive}
            onClick={onClick}
            className={`flex flex-col items-center justify-center gap-3 rounded-xl border py-6 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/60 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-zinc-900 disabled:cursor-not-allowed disabled:opacity-50 ${
              isActive
                ? "border-slate-900 bg-slate-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900"
                : "border-slate-200 bg-slate-50 text-slate-500 hover:border-slate-300 hover:bg-slate-100 hover:text-slate-800 dark:border-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-400 dark:hover:border-zinc-600 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
            }`}
          >
            <span className="shrink-0">{icon}</span>
            <span>{label}</span>
          </button>
        );
      })}
    </div>
  );
}
