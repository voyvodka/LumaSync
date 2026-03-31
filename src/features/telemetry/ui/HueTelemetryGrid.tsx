import { useTranslation } from "react-i18next";

import type { HueTelemetrySnapshot } from "../model/contracts";

interface HueTelemetryGridProps {
  hue: HueTelemetrySnapshot;
}

function formatDuration(secs: number | null): string {
  if (secs === null || secs < 0) return "\u2014";
  const minutes = Math.floor(secs / 60);
  const seconds = Math.round(secs % 60);
  return `${minutes}m ${seconds}s`;
}

export function HueTelemetryGrid({ hue }: HueTelemetryGridProps) {
  const { t } = useTranslation("common");

  const stateColor =
    hue.state === "Running"
      ? "text-emerald-600 dark:text-emerald-400"
      : hue.state === "Reconnecting"
        ? "text-amber-600 dark:text-amber-400"
        : hue.state === "Failed"
          ? "text-rose-600 dark:text-rose-400"
          : "text-slate-900 dark:text-zinc-100";

  return (
    <div className="mt-6">
      <h3 className="text-sm font-semibold tracking-tight">
        {t("telemetry.hue.title")}
      </h3>
      <div className="mt-3 space-y-2">
        <div className="flex items-center justify-between rounded-lg border border-slate-200/80 bg-slate-50/70 px-4 py-2 dark:border-zinc-800 dark:bg-zinc-800/40">
          <span className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-zinc-400">
            {t("telemetry.hue.status")}
          </span>
          <span className={`text-sm ${stateColor}`}>
            {hue.state}
            {hue.uptimeSecs !== null && hue.state === "Running" ? (
              <span className="ml-2 text-xs text-slate-400 dark:text-zinc-500">
                {formatDuration(hue.uptimeSecs)}
              </span>
            ) : null}
          </span>
        </div>

        <div className="flex items-center justify-between rounded-lg border border-slate-200/80 bg-slate-50/70 px-4 py-2 dark:border-zinc-800 dark:bg-zinc-800/40">
          <span className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-zinc-400">
            {t("telemetry.hue.packetRate")}
          </span>
          <span className="text-sm text-slate-900 dark:text-zinc-100">
            {hue.packetRate.toFixed(1)} pkt/s
          </span>
        </div>

        <div className="flex items-center justify-between rounded-lg border border-slate-200/80 bg-slate-50/70 px-4 py-2 dark:border-zinc-800 dark:bg-zinc-800/40">
          <span className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-zinc-400">
            {t("telemetry.hue.lastError")}
          </span>
          <span className="text-sm text-slate-900 dark:text-zinc-100">
            {hue.lastErrorCode
              ? `${hue.lastErrorCode}${hue.lastErrorAtSecs !== null ? ` \u2014 ${Math.floor(hue.lastErrorAtSecs / 60)}m ago` : ""}`
              : "\u2014"}
          </span>
        </div>

        <div className="flex items-center justify-between rounded-lg border border-slate-200/80 bg-slate-50/70 px-4 py-2 dark:border-zinc-800 dark:bg-zinc-800/40">
          <span className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-zinc-400">
            {t("telemetry.hue.reconnects")}
          </span>
          <span className="text-sm text-slate-900 dark:text-zinc-100">
            {hue.totalReconnects} ({hue.successfulReconnects} ok, {hue.failedReconnects} fail)
          </span>
        </div>

        <div className="flex items-center justify-between rounded-lg border border-slate-200/80 bg-slate-50/70 px-4 py-2 dark:border-zinc-800 dark:bg-zinc-800/40">
          <span className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-zinc-400">
            {t("telemetry.hue.dtlsCipher")}
          </span>
          <span className="text-sm text-slate-900 dark:text-zinc-100">
            {hue.dtlsCipher ?? "\u2014"}
          </span>
        </div>

        <div className="flex items-center justify-between rounded-lg border border-slate-200/80 bg-slate-50/70 px-4 py-2 dark:border-zinc-800 dark:bg-zinc-800/40">
          <span className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-zinc-400">
            {t("telemetry.hue.connectionAge")}
          </span>
          <span className="text-sm text-slate-900 dark:text-zinc-100">
            {formatDuration(hue.dtlsConnectedAtSecs)}
          </span>
        </div>
      </div>
    </div>
  );
}
