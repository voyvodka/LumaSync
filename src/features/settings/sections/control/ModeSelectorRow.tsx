import { useTranslation } from "react-i18next";

import {
  LIGHTING_MODE_KIND,
  type AmbilightPayload,
  type LightingModeConfig,
  type LightingModeKind,
} from "../../../mode/model/contracts";

interface ModeSelectorRowProps {
  activeKind: LightingModeKind;
  disabled: boolean;
  ambilightConfig: AmbilightPayload;
  solidDraft: { r: number; g: number; b: number; brightness: number };
  onModeChange: (nextMode: LightingModeConfig) => void;
  /** Compact variant: smaller buttons, smaller icons, tighter padding. */
  compact?: boolean;
  /** Disable every mode EXCEPT Off — used when there is no reachable output. */
  disableNonOffModes?: boolean;
  /**
   * Resolved accent color as a concrete rgb() string. Passed in (rather
   * than read via `var(--accent-color)` inline) so React sets a fresh
   * inline style every render — the Chromium backdrop-filter repaint bug
   * otherwise leaves the active border stale until a scroll forces a
   * repaint.
   */
  accentColor?: string;
}

export function ModeSelectorRow({
  activeKind,
  disabled,
  ambilightConfig,
  solidDraft,
  onModeChange,
  compact = false,
  disableNonOffModes = false,
  accentColor,
}: ModeSelectorRowProps) {
  const { t } = useTranslation("common");

  const solidDotColor = `rgb(${solidDraft.r}, ${solidDraft.g}, ${solidDraft.b})`;
  const iconClass = compact ? "h-5 w-5" : "h-6 w-6";
  const dotClass = compact ? "h-5 w-5" : "h-6 w-6";

  const modes = [
    {
      kind: LIGHTING_MODE_KIND.OFF,
      label: t("general.mode.options.off"),
      icon: (
        <svg viewBox="0 0 24 24" className={iconClass} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <path d="M12 2v6M8.5 4.5A8 8 0 1015.5 4.5" />
        </svg>
      ),
      onClick: () => onModeChange({ kind: LIGHTING_MODE_KIND.OFF }),
    },
    {
      kind: LIGHTING_MODE_KIND.AMBILIGHT,
      label: t("general.mode.options.ambilight"),
      icon: (
        <svg viewBox="0 0 24 24" className={iconClass} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 3L13.5 8.5L19 9L14.5 13L16 18.5L12 15.5L8 18.5L9.5 13L5 9L10.5 8.5L12 3Z" />
        </svg>
      ),
      onClick: () =>
        onModeChange({
          kind: LIGHTING_MODE_KIND.AMBILIGHT,
          ambilight: ambilightConfig,
        }),
    },
    {
      kind: LIGHTING_MODE_KIND.SOLID,
      label: t("general.mode.options.solid"),
      icon: (
        <div
          className={`${dotClass} rounded-full border border-slate-200 dark:border-zinc-600`}
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

  const containerClass = compact ? "grid grid-cols-3 gap-2" : "grid grid-cols-3 gap-3";
  // `border-2` (not `border`) so the active state can paint a 2px accent
  // outline without a 1px layout shift, AND without stacking a native border
  // with a Tailwind `ring-*` (which was producing a visible double-line look
  // because of the `ring-offset-*` gap). One and only one accent outline.
  // No `backdrop-blur-*` here on purpose. The active border reads from a
  // React-driven inline style (`accentColor`), and the card background is
  // a translucent fill so the parent's accent wash flows through naturally.
  // Adding backdrop-filter would introduce the Chromium repaint bug where
  // filter layers don't re-composite when the parent's background-image
  // changes — which is exactly the "stuck on previous color" symptom.
  const buttonBase = compact
    ? "flex flex-col items-center justify-center gap-1.5 rounded-lg border-2 py-2.5 text-[11px] font-medium"
    : "flex flex-col items-center justify-center gap-3 rounded-xl border-2 py-6 text-sm font-medium";

  return (
    <div className={containerClass}>
      {modes.map(({ kind, label, icon, onClick }) => {
        const isActive = activeKind === kind;
        const lockedByNoOutput =
          disableNonOffModes && kind !== LIGHTING_MODE_KIND.OFF;
        return (
          <button
            key={kind}
            type="button"
            disabled={disabled || lockedByNoOutput}
            aria-pressed={isActive}
            onClick={onClick}
            className={`${buttonBase} transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-300/70 focus-visible:ring-offset-2 dark:focus-visible:ring-zinc-500/70 dark:focus-visible:ring-offset-zinc-900 disabled:cursor-not-allowed disabled:opacity-50 ${
              isActive
                // Active: single 2px accent border (set via inline style) +
                // translucent card so the top-down accent wash still seeps
                // through the selected button.
                ? "border-transparent bg-white/70 text-slate-900 shadow-sm dark:bg-zinc-900/55 dark:text-zinc-100"
                // Idle: low-alpha fill + translucent border so the wash
                // flows through every button in the row.
                : "border-slate-200/70 bg-white/35 text-slate-500 hover:border-slate-300 hover:bg-white/55 hover:text-slate-800 dark:border-zinc-800/70 dark:bg-zinc-900/30 dark:text-zinc-400 dark:hover:border-zinc-700 dark:hover:bg-zinc-900/50 dark:hover:text-zinc-200"
            }`}
            style={
              isActive
                ? { borderColor: accentColor ?? "var(--accent-color)" }
                : undefined
            }
          >
            <span className="shrink-0">{icon}</span>
            <span>{label}</span>
          </button>
        );
      })}
    </div>
  );
}
