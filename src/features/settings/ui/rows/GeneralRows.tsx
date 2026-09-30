import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { changeLanguage, I18N_LANGUAGE_NAMES, I18N_SUPPORTED_LANGUAGES, type I18nLanguage } from "@/features/i18n/i18n";
import { shellStore } from "@/features/persistence/shellStore";
import { getStartupEnabled, setStartup } from "@/features/tray/trayController";
import { ChoiceStrip } from "@/shared/ui/ChoiceStrip/ChoiceStrip";
import { Toggle, togglePillClass } from "@/shared/ui/Toggle/Toggle";
import { cx } from "@/shared/lib/cx";
import { RowNote, rowStyles, SettingRow } from "@/shared/ui/SettingRow/SettingRow";

type StartupError = "read" | "write";

/**
 * What the OS last said, kept for the session: a revisit opens on it at once. Unknown (`null`)
 * until the first read lands, and until then no switch is drawn — an "off" switch that slid on
 * when the read came back was a state changing on its own as the page opened.
 */
let knownStartup: boolean | null = null;

/** Test-only: forget the value read in an earlier case. */
export function __resetLaunchAtLoginForTests(): void {
  knownStartup = null;
}

export function LaunchAtLoginRow() {
  const { t } = useTranslation();
  const [enabled, setEnabledState] = useState<boolean | null>(knownStartup);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<StartupError | null>(null);

  const setEnabled = (value: boolean) => {
    knownStartup = value;
    setEnabledState(value);
  };

  useEffect(() => {
    let alive = true;
    // Awaited inside the try, so a read that throws before returning a promise is caught too.
    async function read() {
      try {
        const value = await getStartupEnabled();
        knownStartup = value;
        if (alive) setEnabledState(value);
      } catch (err) {
        console.error("[LumaSync] reading launch at login failed:", err);
        if (!alive) return;
        setError("read");
        // Nothing to show but the error: the switch appears off, as it did before this cache.
        if (knownStartup === null) setEnabledState(false);
      }
    }
    void read();
    return () => {
      alive = false;
    };
  }, []);

  // The requested value, never a flip: a switch showing a stale state would
  // otherwise turn autostart off when the user asked for on.
  async function change(next: boolean) {
    if (loading || enabled === null) return;
    setLoading(true);
    setError(null);
    try {
      setEnabled(await setStartup(next));
    } catch (err) {
      console.error(`[LumaSync] setting launch at login to ${next} failed:`, err);
      setError("write");
      try {
        setEnabled(await getStartupEnabled());
      } catch (readErr) {
        console.error("[LumaSync] re-reading launch at login failed:", readErr);
      }
    } finally {
      setLoading(false);
    }
  }

  const label = t("settings:startupTray.launchAtLogin");
  return (
    <SettingRow
      label={label}
      control={
        enabled === null ? (
          <span className={cx(togglePillClass, rowStyles.placeholder)} aria-hidden="true" />
        ) : (
          <Toggle
            checked={enabled}
            onChange={(next) => {
              void change(next);
            }}
            disabled={loading}
            busy={loading}
            label={label}
            data-testid="launch-at-login-toggle"
          />
        )
      }
    >
      {error !== null && (
        <RowNote tone="error" testId="startup-error">
          {error === "read" ? t("settings:startupTray.readError") : t("settings:startupTray.writeError")}
        </RowNote>
      )}
    </SettingRow>
  );
}

export function LanguageRow() {
  const { t, i18n } = useTranslation();
  const current: I18nLanguage = i18n.language.toLowerCase().startsWith("tr") ? "tr" : "en";

  // Applied for the session even when the save fails; the shell's "settings
  // can't be saved" notice says the choice will not outlive a restart.
  async function change(lang: I18nLanguage) {
    if (lang === current) return;
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

  const label = t("settings:language.label");
  return (
    <SettingRow
      label={label}
      control={
        // Two languages: both on show, each named in itself, rather than behind a list.
        <ChoiceStrip
          label={label}
          value={current}
          options={I18N_SUPPORTED_LANGUAGES.map((lang) => ({ value: lang, label: I18N_LANGUAGE_NAMES[lang] }))}
          onChange={(lang) => void change(lang as I18nLanguage)}
          testIdPrefix="language-"
        />
      }
    />
  );
}
