import { useTranslation } from "react-i18next";

import type { HueAreaChannelInfo } from "../../device/hueOnboardingApi";

const REGIONS = ["left", "right", "top", "bottom", "center"] as const;
type Region = (typeof REGIONS)[number];

interface Props {
  channels: HueAreaChannelInfo[];
  isLoading: boolean;
  overrides: Record<number, string>;
  onSetRegion: (channelIndex: number, region: string | null) => void;
}

function regionLabel(region: string): string {
  const map: Record<string, string> = {
    left: "Left",
    right: "Right",
    top: "Top",
    bottom: "Bottom",
    center: "Center",
  };
  return map[region] ?? region;
}

/** Convert Hue position (x: -1..+1, y: -1..+1) to CSS % inside the grid box.
 *  Hue x: -1=left, +1=right → left%
 *  Hue y: -1=bottom, +1=top → we flip so top of box = top of screen
 */
function posToPercent(x: number, y: number): { left: string; top: string } {
  const left = `${((x + 1) / 2) * 100}%`;
  const top = `${((1 - y) / 2) * 100}%`; // flip Y axis
  return { left, top };
}

const REGION_COLORS: Record<Region, string> = {
  left: "bg-blue-500",
  right: "bg-purple-500",
  top: "bg-emerald-500",
  bottom: "bg-amber-500",
  center: "bg-slate-500",
};

const REGION_COLORS_ACTIVE: Record<Region, string> = {
  left: "bg-blue-600 text-white",
  right: "bg-purple-600 text-white",
  top: "bg-emerald-600 text-white",
  bottom: "bg-amber-600 text-white",
  center: "bg-slate-600 text-white",
};

export function HueChannelMapPanel({ channels, isLoading, overrides, onSetRegion }: Props) {
  const { t } = useTranslation();

  if (isLoading) {
    return (
      <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-zinc-700 dark:bg-zinc-800/50">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-zinc-400">
          {t("device.hue.channelMap.title")}
        </p>
        <p className="mt-1 text-xs text-slate-500 dark:text-zinc-400">{t("device.hue.channelMap.loading")}</p>
      </div>
    );
  }

  if (channels.length === 0) {
    return null;
  }

  return (
    <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-zinc-700 dark:bg-zinc-800/50">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-zinc-400">
        {t("device.hue.channelMap.title")}
      </p>
      <p className="mt-0.5 text-[11px] text-slate-500 dark:text-zinc-400">
        {t("device.hue.channelMap.hint")}
      </p>

      {/* Position grid */}
      <div className="relative mt-2 h-28 overflow-hidden rounded-md border border-slate-200 bg-white dark:border-zinc-600 dark:bg-zinc-900">
        {/* Axis lines */}
        <div className="absolute left-1/2 top-0 h-full w-px -translate-x-1/2 bg-slate-100 dark:bg-zinc-700" />
        <div className="absolute left-0 top-1/2 h-px w-full -translate-y-1/2 bg-slate-100 dark:bg-zinc-700" />

        {/* Region labels */}
        <span className="absolute left-1 top-1/2 -translate-y-1/2 text-[9px] font-semibold uppercase text-slate-300 dark:text-zinc-600">L</span>
        <span className="absolute right-1 top-1/2 -translate-y-1/2 text-[9px] font-semibold uppercase text-slate-300 dark:text-zinc-600">R</span>
        <span className="absolute left-1/2 top-0.5 -translate-x-1/2 text-[9px] font-semibold uppercase text-slate-300 dark:text-zinc-600">T</span>
        <span className="absolute bottom-0.5 left-1/2 -translate-x-1/2 text-[9px] font-semibold uppercase text-slate-300 dark:text-zinc-600">B</span>

        {/* Channel dots */}
        {channels.map((ch) => {
          const { left, top } = posToPercent(ch.positionX, ch.positionY);
          const effectiveRegion = (overrides[ch.index] ?? ch.autoRegion) as Region;
          const colorClass = REGION_COLORS[effectiveRegion] ?? "bg-slate-500";
          const isOverridden = Boolean(overrides[ch.index]);

          return (
            <div
              key={ch.index}
              className="absolute -translate-x-1/2 -translate-y-1/2"
              style={{ left, top }}
            >
              <div
                className={`flex h-5 w-5 items-center justify-center rounded-full text-[9px] font-bold text-white shadow-sm ${colorClass} ${isOverridden ? "ring-2 ring-white ring-offset-1 dark:ring-zinc-900" : ""}`}
              >
                {ch.index + 1}
              </div>
            </div>
          );
        })}
      </div>

      {/* Per-channel region assignment rows */}
      <div className="mt-2 space-y-1.5">
        {channels.map((ch) => {
          const effectiveRegion = (overrides[ch.index] ?? ch.autoRegion) as Region;
          const isOverridden = Boolean(overrides[ch.index]);

          return (
            <div key={ch.index} className="flex items-center gap-2">
              {/* Channel label */}
              <div className="flex w-16 shrink-0 items-center gap-1.5">
                <div
                  className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[9px] font-bold text-white ${REGION_COLORS[effectiveRegion] ?? "bg-slate-500"}`}
                >
                  {ch.index + 1}
                </div>
                <span className="text-[11px] text-slate-600 dark:text-zinc-400">
                  {ch.lightCount === 1 ? t("device.hue.channelMap.oneLight") : t("device.hue.channelMap.lights", { count: ch.lightCount })}
                </span>
              </div>

              {/* Region pills */}
              <div className="flex flex-wrap gap-1">
                {REGIONS.map((region) => {
                  const isActive = effectiveRegion === region;
                  return (
                    <button
                      key={region}
                      type="button"
                      onClick={() => {
                        if (isActive && isOverridden) {
                          onSetRegion(ch.index, null);
                        } else if (!isActive || !isOverridden) {
                          onSetRegion(ch.index, region === ch.autoRegion ? null : region);
                        }
                      }}
                      className={`rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
                        isActive
                          ? REGION_COLORS_ACTIVE[region]
                          : "bg-slate-100 text-slate-500 hover:bg-slate-200 dark:bg-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-600"
                      }`}
                    >
                      {regionLabel(region)}
                    </button>
                  );
                })}
              </div>

              {/* Override indicator */}
              {isOverridden && (
                <button
                  type="button"
                  onClick={() => {
                    onSetRegion(ch.index, null);
                  }}
                  className="ml-auto shrink-0 text-[10px] text-slate-400 underline hover:text-slate-600 dark:text-zinc-500 dark:hover:text-zinc-300"
                  title={t("device.hue.channelMap.resetToAuto")}
                >
                  {t("device.hue.channelMap.auto")}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
