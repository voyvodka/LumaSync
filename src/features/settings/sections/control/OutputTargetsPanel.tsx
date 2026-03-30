import { useTranslation } from "react-i18next";

import type { HueRuntimeTarget } from "../../../../shared/contracts/hue";

interface OutputTargetsPanelProps {
  outputTargets: HueRuntimeTarget[];
  usbConnected: boolean;
  hueConfigured: boolean;
  hueReachable: boolean;
  hueStreaming: boolean;
  disabled: boolean;
  onOutputTargetsChange: (targets: HueRuntimeTarget[]) => void;
}

export function OutputTargetsPanel({
  outputTargets,
  usbConnected,
  hueConfigured,
  hueReachable,
  hueStreaming,
  disabled,
  onOutputTargetsChange,
}: OutputTargetsPanelProps) {
  const { t } = useTranslation("common");

  const devices: { id: HueRuntimeTarget; label: string; available: boolean }[] = [
    { id: "usb", label: t("general.output.devices.usb"), available: usbConnected },
    { id: "hue", label: t("general.output.devices.hue"), available: hueConfigured && hueReachable },
  ];

  const toggleTarget = (id: HueRuntimeTarget, currentlySelected: boolean) => {
    const next = currentlySelected
      ? outputTargets.filter((target) => target !== id)
      : [...outputTargets, id as HueRuntimeTarget];
    if (next.length > 0) onOutputTargetsChange(next);
  };

  return (
    <div className="rounded-xl border border-slate-200/80 bg-white/90 px-5 py-4 dark:border-zinc-800 dark:bg-zinc-900/80">
      <p className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-slate-400 dark:text-zinc-500">
        {t("general.output.title")}
      </p>
      <div className="flex flex-wrap gap-2">
        {devices.map(({ id, label, available }) => {
          const selected = outputTargets.includes(id);
          const isLastSelected = selected && outputTargets.length === 1;
          const isDisabled = disabled || !available || isLastSelected;
          const isHueStreamingActive = id === "hue" && available && selected && hueStreaming;
          return (
            <button
              key={id}
              type="button"
              disabled={isDisabled}
              onClick={() => toggleTarget(id, selected)}
              className={`inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/60 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-zinc-900 disabled:cursor-not-allowed ${
                selected && available
                  ? "border-slate-900 bg-slate-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900"
                  : available
                    ? "border-slate-200 bg-white text-slate-700 hover:border-slate-400 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:border-zinc-500"
                    : "border-slate-200 bg-white text-slate-400 opacity-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-600"
              }`}
            >
              {isHueStreamingActive ? (
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500 animate-pulse" />
              ) : (
                <span
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                    available
                      ? selected
                        ? "bg-emerald-400 dark:bg-emerald-600"
                        : "bg-emerald-500"
                      : "bg-slate-300 dark:bg-zinc-600"
                  }`}
                />
              )}
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
