import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { getRuntimeTelemetrySnapshot } from "../telemetryApi";
import type { RuntimeTelemetrySnapshot } from "../model/contracts";

const POLL_INTERVAL_MS = 750;

function formatFps(value: number): string {
  return value.toFixed(2);
}

export function TelemetrySection() {
  const { t } = useTranslation("common");
  const [snapshot, setSnapshot] = useState<RuntimeTelemetrySnapshot | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);

  useEffect(() => {
    let mounted = true;

    const refresh = async () => {
      try {
        const next = await getRuntimeTelemetrySnapshot();
        if (!mounted) {
          return;
        }

        setSnapshot(next);
        setHasError(false);
      } catch {
        if (!mounted) {
          return;
        }

        setHasError(true);
      } finally {
        if (mounted) {
          setIsLoading(false);
        }
      }
    };

    void refresh();
    const intervalId = window.setInterval(() => {
      void refresh();
    }, POLL_INTERVAL_MS);

    return () => {
      mounted = false;
      window.clearInterval(intervalId);
    };
  }, []);

  const showEmpty =
    !isLoading
    && !hasError
    && snapshot !== null
    && snapshot.captureFps === 0
    && snapshot.sendFps === 0;

  return (
    <section className="w-full rounded-xl border border-slate-200/80 bg-white/90 p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/80 ">
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
        <div className="mt-6 grid gap-3 grid-cols-3">
          <article className="rounded-xl border border-slate-200/80 bg-slate-50/70 p-4 dark:border-zinc-800 dark:bg-zinc-800/40">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-zinc-400">
              {t("telemetry.metrics.captureFps")}
            </p>
            <p className="mt-2 text-2xl font-semibold text-slate-900 dark:text-zinc-100">{formatFps(snapshot.captureFps)}</p>
          </article>

          <article className="rounded-xl border border-slate-200/80 bg-slate-50/70 p-4 dark:border-zinc-800 dark:bg-zinc-800/40">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-zinc-400">
              {t("telemetry.metrics.sendFps")}
            </p>
            <p className="mt-2 text-2xl font-semibold text-slate-900 dark:text-zinc-100">{formatFps(snapshot.sendFps)}</p>
          </article>

          <article className="rounded-xl border border-slate-200/80 bg-slate-50/70 p-4 dark:border-zinc-800 dark:bg-zinc-800/40">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-zinc-400">
              {t("telemetry.metrics.queueHealth")}
            </p>
            <p className="mt-2 text-2xl font-semibold text-slate-900 capitalize dark:text-zinc-100">
              {t(`telemetry.queueHealth.${snapshot.queueHealth}`)}
            </p>
          </article>
        </div>
      ) : null}

      {showEmpty ? (
        <p className="mt-4 text-sm text-slate-600 dark:text-zinc-300">{t("telemetry.states.empty")}</p>
      ) : null}
    </section>
  );
}
