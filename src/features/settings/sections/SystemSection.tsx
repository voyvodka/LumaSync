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
import type { UpdaterState } from "../../updater/useAutoUpdater";
import { DevUpdaterMenu } from "../../updater/DevUpdaterMenu";

interface SystemSectionProps {
  onCheckForUpdates: () => void;
  isCheckingForUpdates: boolean;
  devSetUpdaterState?: (state: UpdaterState) => void;
  usbConnected: boolean;
}

export function SystemSection({ onCheckForUpdates, isCheckingForUpdates, devSetUpdaterState, usbConnected }: SystemSectionProps) {
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
      } catch (err) {
        console.error("[LumaSync] listenStartupToggle subscribe failed:", err);
      }
    }

    void init();
    return () => { unlistenFn?.(); };
  }, []);

  async function handleLanguageChange(lang: I18nLanguage) {
    if (lang === currentLanguage) return;
    await changeLanguage(lang);
    try {
      await shellStore.save({ language: lang });
    } catch (err) {
      console.error("[LumaSync] shellStore.save(language) failed:", err);
    }
  }

  async function handleStartupToggle() {
    if (startupLoading) return;
    try {
      const newState = await toggleStartup();
      setStartupEnabled(newState);
    } catch (err) {
      console.error("[LumaSync] toggleStartup failed:", err);
    }
  }

  return (
    <div className="lm-settings-page">
      <div className="lm-settings-head">
        <h1>{t("settingsPage.title")}</h1>
        <div className="lm-settings-head-sub">{t("settingsPage.subtitle")}</div>
      </div>

      {/* Startup group */}
      <section className="lm-settings-group">
        <div className="lm-settings-group-h">
          <span className="t">{t("settingsPage.groups.startup.title")}</span>
          <span className="sub">{t("settingsPage.groups.startup.sub")}</span>
        </div>
        <div className="lm-settings-row">
          <div className="lm-settings-row-l">
            <div className="lm-settings-row-name">{t("startupTray.launchAtLogin")}</div>
            <div className="lm-settings-row-desc">{t("startupTray.launchAtLoginDescription")}</div>
          </div>
          <div className="lm-settings-row-r">
            <button
              type="button"
              className={`lm-settings-tg ${startupEnabled ? "is-on" : ""}`}
              onClick={() => { void handleStartupToggle(); }}
              disabled={startupLoading}
              aria-busy={startupLoading}
              aria-pressed={startupEnabled}
              aria-label={t("startupTray.launchAtLogin")}
            />
          </div>
        </div>
      </section>

      {/* Language group */}
      <section className="lm-settings-group">
        <div className="lm-settings-group-h">
          <span className="t">{t("settingsPage.groups.language.title")}</span>
          <span className="sub">{t("settingsPage.groups.language.sub")}</span>
        </div>
        <div className="lm-settings-row">
          <div className="lm-settings-row-l">
            <div className="lm-settings-row-name">{t("settingsPage.language.label")}</div>
            <div className="lm-settings-row-desc">{t("settingsPage.language.description")}</div>
          </div>
          <div className="lm-settings-row-r">
            <div className="lm-settings-seg" role="radiogroup" aria-label={t("settingsPage.language.label")}>
              {I18N_SUPPORTED_LANGUAGES.map((lang) => {
                const active = currentLanguage === lang;
                return (
                  <button
                    key={lang}
                    type="button"
                    className={active ? "is-on" : ""}
                    onClick={() => { void handleLanguageChange(lang); }}
                    role="radio"
                    aria-checked={active}
                  >
                    {lang.toUpperCase()}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </section>

      {/* Updates group */}
      <section className="lm-settings-group">
        <div className="lm-settings-group-h">
          <span className="t">{t("settingsPage.groups.updates.title")}</span>
          <span className="sub">{t("settingsPage.groups.updates.sub")}</span>
        </div>
        <div className="lm-settings-row">
          <div className="lm-settings-row-l">
            <div className="lm-settings-row-name">{t("updater.checkForUpdates")}</div>
            <div className="lm-settings-row-desc">{t("updater.checkForUpdatesDescription")}</div>
          </div>
          <div className="lm-settings-row-r flex items-center gap-2">
            {import.meta.env.DEV && devSetUpdaterState && (
              <DevUpdaterMenu onSetState={devSetUpdaterState} />
            )}
            <button
              type="button"
              className="lm-settings-btn"
              onClick={onCheckForUpdates}
              disabled={isCheckingForUpdates}
              aria-busy={isCheckingForUpdates}
            >
              {isCheckingForUpdates ? t("updater.checking") : t("updater.checkAction")}
            </button>
          </div>
        </div>
      </section>

      {/* About group */}
      <section className="lm-settings-group">
        <div className="lm-settings-group-h">
          <span className="t">{t("settingsPage.groups.about.title")}</span>
          <span className="sub">{t("settingsPage.groups.about.sub")}</span>
        </div>
        <div className="lm-settings-about">
          <div className="lm-settings-about-logo">L</div>
          <div>
            <div className="lm-settings-about-tx-n">{APP_NAME}</div>
            <div className="lm-settings-about-tx-s">
              {t("settingsPage.about.tagline")} · <b>com.lumasync.app</b> · {t("settingsPage.about.license")} · <a href="https://lumasync.app" target="_blank" rel="noreferrer noopener">lumasync.app</a>
            </div>
          </div>
          <div className="lm-settings-about-v">v{APP_VERSION}</div>
        </div>
      </section>

      {/* Telemetry (preserved) */}
      <section className="lm-settings-group">
        <TelemetrySection usbConnected={usbConnected} />
      </section>
    </div>
  );
}
