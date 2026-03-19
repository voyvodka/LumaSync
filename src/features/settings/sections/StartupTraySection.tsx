import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  getStartupEnabled,
  listenStartupToggle,
  toggleStartup,
} from "../../tray/trayController";

export function StartupTraySection() {
  const { t } = useTranslation("common");
  const [startupEnabled, setStartupEnabled] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let unlistenFn: (() => void) | null = null;

    async function init() {
      try {
        const enabled = await getStartupEnabled();
        setStartupEnabled(enabled);
      } catch {
        setStartupEnabled(false);
      } finally {
        setLoading(false);
      }

      try {
        unlistenFn = await listenStartupToggle((newState) => {
          setStartupEnabled(newState);
        });
      } catch {}
    }

    void init();

    return () => {
      unlistenFn?.();
    };
  }, []);

  async function handleToggle() {
    try {
      const newState = await toggleStartup();
      setStartupEnabled(newState);
    } catch {}
  }

  return (
    <section className="mx-auto w-full max-w-3xl rounded-2xl border border-slate-200/80 bg-white/90 p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/80 sm:p-8">
      <h2 className="text-xl font-semibold tracking-tight">{t("startupTray.title")}</h2>

      <div className="mt-6 space-y-4">
        <div className="flex items-center justify-between gap-6 border-b border-slate-200/80 pb-4 dark:border-zinc-800">
          <div className="min-w-0">
            <p className="text-sm font-medium text-slate-900 dark:text-zinc-100">
              {t("startupTray.launchAtLogin")}
            </p>
            <p className="mt-1 text-sm text-slate-600 dark:text-zinc-300">
              {t("startupTray.launchAtLoginDescription")}
            </p>
          </div>

          <button
            type="button"
            className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-600 ${
              startupEnabled
                ? "bg-slate-900 dark:bg-zinc-100"
                : "bg-slate-300 dark:bg-zinc-700"
            }`}
            onClick={() => {
              void handleToggle();
            }}
            disabled={loading}
            aria-pressed={startupEnabled}
            aria-label={t("startupTray.launchAtLogin")}
          >
            <span
              className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform dark:bg-zinc-900 ${
                startupEnabled ? "translate-x-5" : "translate-x-1"
              }`}
            />
          </button>
        </div>

        <div className="flex items-center justify-between gap-6">
          <div className="min-w-0">
            <p className="text-sm font-medium text-slate-900 dark:text-zinc-100">Minimize to tray on close</p>
            <p className="mt-1 text-sm text-slate-600 dark:text-zinc-300">{t("startupTray.trayInfo")}</p>
          </div>
          <span className="rounded-md bg-slate-200 px-2 py-1 text-xs font-medium text-slate-600 dark:bg-zinc-800 dark:text-zinc-300">
            Always on
          </span>
        </div>
      </div>
    </section>
  );
}
