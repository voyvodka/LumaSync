import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { getFullTelemetrySnapshot } from "../telemetryApi";
import type { FullTelemetrySnapshot } from "../model/contracts";
import { HueTelemetryGrid } from "./HueTelemetryGrid";

const POLL_INTERVAL_MS = 2000;

function formatFps(value: number): string {
  return value.toFixed(2);
}

function queueHealthColor(health: string): string {
  if (health === "healthy") return "text-emerald-600 dark:text-emerald-400";
  if (health === "warning") return "text-amber-600 dark:text-amber-400";
  if (health === "critical") return "text-rose-600 dark:text-rose-400";
  return "text-slate-900 dark:text-zinc-100";
}

export function TelemetrySection() {
  const { t } = useTranslation("common");
  const [snapshot, setSnapshot] = useState<FullTelemetrySnapshot | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);

  useEffect(() => {
    let mounted = true;

    const refresh = async () => {
      // Skip poll when tab/window is not visible (P3-1)
      if (document.visibilityState === "hidden") return;

      try {
        const next = await getFullTelemetrySnapshot();
        if (!mounted) return;
        setSnapshot(next);
        setHasError(false);
      } catch {
        if (!mounted) return;
        setHasError(true);
      } finally {
        if (mounted) setIsLoading(false);
      }
    };

    void refresh();
    const intervalId = window.setInterval(() => { void refresh(); }, POLL_INTERVAL_MS);

    return () => {
      mounted = false;
      window.clearInterval(intervalId);
    };
  }, []);

  const showEmpty =
    !isLoading
    && !hasError
    && snapshot !== null
    && snapshot.usb.captureFps === 0
    && snapshot.usb.sendFps === 0
    && snapshot.hue === null;

  return (
    <section className="w-full rounded-xl border border-slate-200/80 bg-white/90 p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/80">
      <h2 className="text-sm font-semibold tracking-tight">{t("telemetry.title")}</h2>
      <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-zinc-300">{t("telemetry.description")}</p>

      {isLoading ? (
        <p className="mt-6 rounded-lg border border-slate-200 bg-slate-50/80 px-4 py-3 text-sm text-slate-600 dark:border-zinc-700 dark:bg-zinc-800/50 dark:text-zinc-300">
          {t("telemetry.states.loading")}
        </p>
      ) : null}

      {!isLoading && hasError ? (
        <p className="mt-6 rounded-lg border border-rose-200 bg-rose-50/80 px-4 py-3 text-sm text-rose-700 dark:border-rose-500/40 dark:bg-rose-900/20 dark:text-rose-300">
          {t("telemetry.states.error")}
        </p>
      ) : null}

      {!isLoading && !hasError && snapshot ? (
        <div className="mt-6 space-y-3">
          {/* FPS metrics side by side (P3-2) */}
          <div className="grid grid-cols-2 gap-3">
            <article className="rounded-xl border border-slate-200/80 bg-slate-50/70 p-4 dark:border-zinc-800 dark:bg-zinc-800/40">
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-zinc-400">
                {t("telemetry.metrics.captureFps")}
              </p>
              <p className="mt-2 text-2xl font-semibold tabular-nums text-slate-900 dark:text-zinc-100">{formatFps(snapshot.usb.captureFps)}</p>
            </article>

            <article className="rounded-xl border border-slate-200/80 bg-slate-50/70 p-4 dark:border-zinc-800 dark:bg-zinc-800/40">
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-zinc-400">
                {t("telemetry.metrics.sendFps")}
              </p>
              <p className="mt-2 text-2xl font-semibold tabular-nums text-slate-900 dark:text-zinc-100">{formatFps(snapshot.usb.sendFps)}</p>
            </article>
          </div>

          {/* Queue health full width with color coding (P3-2) */}
          <article className="rounded-xl border border-slate-200/80 bg-slate-50/70 p-4 dark:border-zinc-800 dark:bg-zinc-800/40">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-zinc-400">
              {t("telemetry.metrics.queueHealth")}
            </p>
            <p className={`mt-2 text-2xl font-semibold capitalize ${queueHealthColor(snapshot.usb.queueHealth)}`}>
              {t(`telemetry.queueHealth.${snapshot.usb.queueHealth}`)}
            </p>
          </article>
        </div>
      ) : null}

      {!isLoading && !hasError && snapshot?.hue ? (
        <HueTelemetryGrid hue={snapshot.hue} />
      ) : null}

      {showEmpty ? (
        <p className="mt-4 text-sm text-slate-600 dark:text-zinc-300">{t("telemetry.states.empty")}</p>
      ) : null}
    </section>
  );
}
