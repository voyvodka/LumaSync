import { useEffect, useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Toggle } from "@/shared/ui/Toggle";
import { TelemetrySection } from "@/features/telemetry/ui/TelemetrySection";
import { setShowNerdStats, useShowNerdStats } from "@/features/telemetry/nerdStatsSetting";
import {
  changeLanguage,
  I18N_LANGUAGE_NAMES,
  I18N_SUPPORTED_LANGUAGES,
  type I18nLanguage,
} from "@/features/i18n/i18n";
import { shellStore } from "@/features/persistence/shellStore";
import { getStartupEnabled, setStartup } from "@/features/tray/trayController";
import { APP_NAME, APP_VERSION } from "@/shared/constants/app";
import { DEFAULT_UPDATE_CHANNEL, type UpdateChannel } from "@/shared/contracts/shell";
import type { UpdaterState } from "@/features/updater/useAutoUpdater";
import { DevUpdaterMenu } from "@/features/updater/DevUpdaterMenu";

/** How long "you're on the latest version" stays after a check the user asked for. */
export const UP_TO_DATE_RESULT_MS = 12_000;

type StartupError = "read" | "write";

interface SystemSectionProps {
  onCheckForUpdates: () => void;
  isCheckingForUpdates: boolean;
  /** When a check the user asked for last found nothing newer. */
  upToDateAt?: number | null;
  devSetUpdaterState?: (state: UpdaterState) => void;
  localOutputConnected: boolean;
  /** The app owns a Hue session, which has telemetry of its own. */
  hueActive?: boolean;
}

interface SettingsGroupProps {
  title: string;
  sub: string;
  children: ReactNode;
}

/** A titled group: a real heading, so a screen reader can jump between groups. */
function SettingsGroup({ title, sub, children }: SettingsGroupProps) {
  const headingId = useId();
  return (
    <section className="lm-settings-group" aria-labelledby={headingId}>
      <div className="lm-settings-group-h">
        <h2 className="t" id={headingId}>{title}</h2>
        <span className="sub">{sub}</span>
      </div>
      {children}
    </section>
  );
}

export function SystemSection({
  onCheckForUpdates,
  isCheckingForUpdates,
  upToDateAt = null,
  devSetUpdaterState,
  localOutputConnected,
  hueActive = false,
}: SystemSectionProps) {
  const { t, i18n } = useTranslation();
  const currentLanguage: I18nLanguage = i18n.language.toLowerCase().startsWith("tr") ? "tr" : "en";
  const [startupEnabled, setStartupEnabled] = useState(false);
  const [startupError, setStartupError] = useState<StartupError | null>(null);
  const [updateChannel, setUpdateChannel] = useState<UpdateChannel>(DEFAULT_UPDATE_CHANNEL);
  const [startupLoading, setStartupLoading] = useState(true);
  const showNerdStats = useShowNerdStats();
  const startupDescId = useId();
  const languageDescId = useId();
  const channelDescId = useId();
  const nerdStatsDescId = useId();

  useEffect(() => {
    async function init() {
      try {
        setStartupEnabled(await getStartupEnabled());
      } catch (err) {
        console.error("[LumaSync] reading launch at login failed:", err);
        setStartupError("read");
      } finally {
        setStartupLoading(false);
      }

      try {
        const persisted = await shellStore.load();
        setUpdateChannel(persisted.updateChannel ?? DEFAULT_UPDATE_CHANNEL);
      } catch (err) {
        console.error("[LumaSync] loading the update channel failed:", err);
        setUpdateChannel(DEFAULT_UPDATE_CHANNEL);
      }
    }

    void init();
  }, []);

  // The up-to-date line is a result, not a state: it goes once read.
  const [expiredUpToDateAt, setExpiredUpToDateAt] = useState<number | null>(null);
  useEffect(() => {
    if (upToDateAt === null) return;
    const timerId = window.setTimeout(() => setExpiredUpToDateAt(upToDateAt), UP_TO_DATE_RESULT_MS);
    return () => window.clearTimeout(timerId);
  }, [upToDateAt]);
  const upToDateShown = upToDateAt !== null && upToDateAt !== expiredUpToDateAt && !isCheckingForUpdates;
  const upToDateTime = upToDateShown
    ? new Intl.DateTimeFormat(i18n.language, { hour: "2-digit", minute: "2-digit" }).format(upToDateAt)
    : "";

  // Applied for the session even when the save fails; the shell's "settings
  // can't be saved" notice says the choice will not outlive a restart.
  async function handleLanguageChange(lang: I18nLanguage) {
    if (lang === currentLanguage) return;
    try {
      await changeLanguage(lang);
    } catch (err) {
      console.error("[LumaSync] switching the interface language failed:", err);
      return;
    }
    try {
      await shellStore.save({ language: lang });
    } catch (err) {
      console.error("[LumaSync] shellStore.save(language) failed:", err);
    }
  }

  async function handleChannelToggle() {
    const next: UpdateChannel = updateChannel === "beta" ? "stable" : "beta";
    // Optimistic, then reverted on failure: Rust reads this same field off disk
    // to pick the endpoint, so a toggle the store rejected must not look on.
    setUpdateChannel(next);
    try {
      await shellStore.save({ updateChannel: next });
    } catch (err) {
      console.error("[LumaSync] shellStore.save(updateChannel) failed:", err);
      setUpdateChannel(updateChannel);
    }
  }

  // The requested value, never a flip: a switch showing a stale state would
  // otherwise turn autostart off when the user asked for on.
  async function handleStartupChange(next: boolean) {
    if (startupLoading) return;
    setStartupLoading(true);
    setStartupError(null);
    try {
      setStartupEnabled(await setStartup(next));
    } catch (err) {
      console.error(`[LumaSync] setting launch at login to ${next} failed:`, err);
      setStartupError("write");
      try {
        setStartupEnabled(await getStartupEnabled());
      } catch (readErr) {
        console.error("[LumaSync] re-reading launch at login failed:", readErr);
      }
    } finally {
      setStartupLoading(false);
    }
  }

  return (
    <div className="lm-settings-page">
      <div className="lm-settings-head">
        <h1>{t("settings:title")}</h1>
        <div className="lm-settings-head-sub">{t("settings:subtitle")}</div>
      </div>

      <SettingsGroup title={t("settings:groups.startup.title")} sub={t("settings:groups.startup.sub")}>
        <div className="lm-settings-row">
          <div className="lm-settings-row-l">
            <div className="lm-settings-row-name">{t("settings:startupTray.launchAtLogin")}</div>
            <div className="lm-settings-row-desc" id={startupDescId}>
              {t("settings:startupTray.launchAtLoginDescription")}
            </div>
            {startupError !== null ? (
              <p className="lm-settings-row-error" role="alert" data-testid="startup-error">
                {startupError === "read"
                  ? t("settings:startupTray.readError")
                  : t("settings:startupTray.writeError")}
              </p>
            ) : null}
          </div>
          <div className="lm-settings-row-r">
            <Toggle
              checked={startupEnabled}
              onChange={(next) => { void handleStartupChange(next); }}
              disabled={startupLoading}
              busy={startupLoading}
              label={t("settings:startupTray.launchAtLogin")}
              aria-describedby={startupDescId}
              data-testid="launch-at-login-toggle"
            />
          </div>
        </div>
      </SettingsGroup>

      <SettingsGroup title={t("settings:groups.language.title")} sub={t("settings:groups.language.sub")}>
        <div className="lm-settings-row">
          <div className="lm-settings-row-l">
            <div className="lm-settings-row-name">{t("settings:language.label")}</div>
            <div className="lm-settings-row-desc" id={languageDescId}>{t("settings:language.description")}</div>
          </div>
          <div className="lm-settings-row-r">
            <select
              className="lm-settings-select"
              aria-label={t("settings:language.label")}
              aria-describedby={languageDescId}
              value={currentLanguage}
              onChange={(e) => { void handleLanguageChange(e.target.value as I18nLanguage); }}
            >
              {I18N_SUPPORTED_LANGUAGES.map((lang) => (
                <option key={lang} value={lang}>
                  {I18N_LANGUAGE_NAMES[lang]}
                </option>
              ))}
            </select>
          </div>
        </div>
      </SettingsGroup>

      <SettingsGroup title={t("settings:groups.updates.title")} sub={t("settings:groups.updates.sub")}>
        <div className="lm-settings-row">
          <div className="lm-settings-row-l">
            <div className="lm-settings-row-name">{t("updater:checkForUpdates")}</div>
            <div className="lm-settings-row-desc">{t("updater:checkForUpdatesDescription")}</div>
            {/* Mounted empty, so the result is announced when it lands. */}
            <p className="lm-settings-row-result" role="status" aria-live="polite" data-testid="update-check-result">
              {upToDateShown ? t("updater:upToDate", { time: upToDateTime }) : ""}
            </p>
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
              {isCheckingForUpdates ? t("updater:checking") : t("updater:checkAction")}
            </button>
          </div>
        </div>
        <div className="lm-settings-row">
          <div className="lm-settings-row-l">
            <div className="lm-settings-row-name">{t("updater:betaChannel")}</div>
            <div className="lm-settings-row-desc" id={channelDescId}>{t("updater:betaChannelDescription")}</div>
          </div>
          <div className="lm-settings-row-r">
            <Toggle
              checked={updateChannel === "beta"}
              onChange={() => { void handleChannelToggle(); }}
              label={t("updater:betaChannel")}
              aria-describedby={channelDescId}
            />
          </div>
        </div>
      </SettingsGroup>

      {/* Telemetry — the readout mounts only with stats for nerds on */}
      <SettingsGroup title={t("telemetry:title")} sub={t("settings:groups.telemetry.sub")}>
        <div className="lm-settings-row">
          <div className="lm-settings-row-l">
            <div className="lm-settings-row-name">{t("settings:nerdStats.label")}</div>
            <div className="lm-settings-row-desc" id={nerdStatsDescId}>{t("settings:nerdStats.description")}</div>
          </div>
          <div className="lm-settings-row-r">
            <Toggle
              checked={showNerdStats}
              onChange={(next) => { void setShowNerdStats(next); }}
              label={t("settings:nerdStats.label")}
              aria-describedby={nerdStatsDescId}
              data-testid="nerd-stats-toggle"
            />
          </div>
        </div>
        {showNerdStats && <TelemetrySection localOutputConnected={localOutputConnected} hueActive={hueActive} />}
      </SettingsGroup>

      <SettingsGroup title={t("settings:groups.about.title")} sub={t("settings:groups.about.sub")}>
        <div className="lm-settings-about">
          <div className="lm-settings-about-logo" aria-hidden="true">L</div>
          <div>
            <div className="lm-settings-about-tx-n">{APP_NAME}</div>
            <div className="lm-settings-about-tx-s">
              {t("settings:about.tagline")} · <b>com.lumasync.app</b> · {t("settings:about.license")} · <a href="https://lumasync.app" target="_blank" rel="noreferrer noopener">lumasync.app</a>
            </div>
          </div>
          <div className="lm-settings-about-v">v{APP_VERSION}</div>
        </div>
      </SettingsGroup>
    </div>
  );
}
