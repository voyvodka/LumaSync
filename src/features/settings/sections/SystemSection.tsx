import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { TelemetrySection } from "../../telemetry/ui/TelemetrySection";
import { changeLanguage, I18N_SUPPORTED_LANGUAGES, type I18nLanguage } from "../../i18n/i18n";
import { shellStore } from "../../persistence/shellStore";
import {
  getStartupEnabled,
  listenStartupToggle,
  setStartupTrayChecked,
  toggleStartup,
} from "../../tray/trayController";
import { APP_NAME, APP_VERSION } from "../../../shared/constants/app";

interface SystemSectionProps {
  onCheckForUpdates: () => void;
  isCheckingForUpdates: boolean;
}

export function SystemSection({ onCheckForUpdates, isCheckingForUpdates }: SystemSectionProps) {
  const { t, i18n } = useTranslation("common");
  const currentLanguage: I18nLanguage = i18n.language.toLowerCase().startsWith("tr") ? "tr" : "en";
  const [startupEnabled, setStartupEnabled] = useState(false);
  const [startupLoading, setStartupLoading] = useState(true);

  useEffect(() => {
    let unlistenFn: (() => void) | null = null;

    async function init() {
      try {
        const enabled = await getStartupEnabled();
        setStartupEnabled(enabled);
        await setStartupTrayChecked(enabled);
      } catch {
        setStartupEnabled(false);
      } finally {
        setStartupLoading(false);
      }

      try {
        unlistenFn = await listenStartupToggle((newState) => {
          setStartupEnabled(newState);
        });
      } catch {}
    }

    void init();
    return () => { unlistenFn?.(); };
  }, []);

  async function handleLanguageChange(lang: I18nLanguage) {
    if (lang === currentLanguage) return;
    await changeLanguage(lang);
    try { await shellStore.save({ language: lang }); } catch {}
  }

  async function handleStartupToggle() {
    try {
      const newState = await toggleStartup();
      setStartupEnabled(newState);
    } catch {}
  }

  return (
    <div className="divide-y divide-slate-200/70 dark:divide-zinc-800">
      {/* Language */}
      <div className="px-6 py-5">
        <p className="text-sm font-semibold text-slate-900 dark:text-zinc-100">{t("language.title")}</p>
        <div className="mt-3 flex gap-2" role="radiogroup" aria-label={t("language.title")}>
          {I18N_SUPPORTED_LANGUAGES.map((lang) => {
            const active = currentLanguage === lang;
            return (
              <label
                key={lang}
                className={`flex cursor-pointer items-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium transition-colors ${
                  active
                    ? "border-slate-900 bg-slate-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900"
                    : "border-slate-300 bg-transparent text-slate-700 hover:border-slate-500 dark:border-zinc-700 dark:text-zinc-200 dark:hover:border-zinc-500"
                }`}
              >
                <input
                  type="radio"
                  name="language"
                  value={lang}
                  checked={active}
                  onChange={() => { void handleLanguageChange(lang); }}
                  className="sr-only"
                />
                <span>{t(`language.options.${lang}`)}</span>
                <span className={`text-xs ${active ? "text-white/70 dark:text-zinc-600" : "text-slate-400 dark:text-zinc-500"}`}>
                  {lang.toUpperCase()}
                </span>
              </label>
            );
          })}
        </div>
      </div>

      {/* Startup & Tray — "minimize on close / always on" row removed (P2-8) */}
      <div className="px-6 py-5">
        <p className="text-sm font-semibold text-slate-900 dark:text-zinc-100">{t("startupTray.title")}</p>
        <div className="mt-3 rounded-xl border border-slate-200/80 bg-slate-50/50 dark:border-zinc-800 dark:bg-zinc-800/30">
          <div className="flex items-center justify-between gap-6 px-4 py-3.5">
            <div className="min-w-0">
              <p className="text-sm font-medium text-slate-900 dark:text-zinc-100">
                {t("startupTray.launchAtLogin")}
              </p>
              <p className="mt-0.5 text-xs text-slate-500 dark:text-zinc-400">
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
              onClick={() => { void handleStartupToggle(); }}
              disabled={startupLoading}
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
        </div>
      </div>

      {/* About & Software Updates */}
      <div className="px-6 py-5">
        <p className="text-sm font-semibold text-slate-900 dark:text-zinc-100">{t("aboutLogs.title")}</p>
        <div className="mt-3 divide-y divide-slate-100 dark:divide-zinc-800/70 rounded-xl border border-slate-200/80 bg-slate-50/50 dark:border-zinc-800 dark:bg-zinc-800/30">
          <div className="px-4 py-3.5">
            <p className="text-sm font-medium text-slate-900 dark:text-zinc-100">{APP_NAME}</p>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-zinc-400">
              {t("aboutLogs.version")} {APP_VERSION}
            </p>
          </div>
          <div className="flex items-center justify-between gap-4 px-4 py-3.5">
            <div>
              <p className="text-sm font-medium text-slate-900 dark:text-zinc-100">{t("updater.checkForUpdates")}</p>
              <p className="mt-0.5 text-xs text-slate-500 dark:text-zinc-400">{t("updater.checkForUpdatesDescription")}</p>
            </div>
            <button
              type="button"
              onClick={onCheckForUpdates}
              disabled={isCheckingForUpdates}
              className="shrink-0 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/60"
            >
              {isCheckingForUpdates ? t("updater.checking") : t("updater.checkAction")}
            </button>
          </div>
        </div>
      </div>

      {/* Telemetry */}
      <div className="px-6 py-5">
        <TelemetrySection />
      </div>
    </div>
  );
}
