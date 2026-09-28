import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import type { SetupGuideRestartResult } from "@/features/onboarding/state/setupGuideControl";
import { openLogDir } from "@/features/platform/platformApi";
import { zoomBadges } from "@/features/shell/zoomKeybinds";
import { APP_VERSION } from "@/shared/constants/app";
import { IconCheck } from "@/shared/ui/icons";
import { StateSwap } from "@/shared/ui/StateSwap/StateSwap";
import { getKeybindDefinition, KEYBIND_ACTIONS, resolveKeybindPlatform } from "@/shared/contracts/shell";
import { buildIssueReportUrl, detectOsName, DISCUSSIONS_URL } from "../helpLinks";
import { RowButton, RowLink, RowNote, SettingRow } from "@/shared/ui/SettingRow/SettingRow";
import type { SettingsEnv } from "../settingsEnv";
import styles from "./HelpRows.module.css";

export function SetupGuideRow({ onRestartSetupGuide }: SettingsEnv) {
  const { t } = useTranslation();
  const [result, setResult] = useState<SetupGuideRestartResult | null>(null);
  if (!onRestartSetupGuide) return null;
  return (
    <SettingRow
      label={t("settings:help.guide.label")}
      hint={t("settings:help.guide.description")}
      control={
        <RowButton onClick={() => setResult(onRestartSetupGuide())} data-testid="setup-guide-restart">
          {t("settings:help.guide.action")}
        </RowButton>
      }
    >
      <RowNote tone="status" testId="setup-guide-result">
        {result === "shown" ? t("settings:help.guide.shown") : result === "alreadyDone" ? t("settings:help.guide.alreadyDone") : ""}
      </RowNote>
    </SettingRow>
  );
}

export function LogFolderRow() {
  const { t } = useTranslation();
  const [failed, setFailed] = useState(false);

  async function open() {
    setFailed(false);
    try {
      await openLogDir();
    } catch (err) {
      console.error("[LumaSync] opening the log folder failed:", err);
      setFailed(true);
    }
  }

  return (
    <SettingRow
      label={t("settings:help.logs.label")}
      hint={t("settings:help.logs.description")}
      control={
        <RowButton onClick={() => void open()} data-testid="open-log-folder">
          {t("settings:help.logs.action")}
        </RowButton>
      }
    >
      {failed && (
        <RowNote tone="error" testId="log-folder-error">
          {t("settings:help.logs.error")}
        </RowNote>
      )}
    </SettingRow>
  );
}

export function ReportIssueRow() {
  const { t } = useTranslation();
  const [url] = useState(() => buildIssueReportUrl(APP_VERSION, detectOsName()));
  return (
    <SettingRow
      label={t("settings:help.issue.label")}
      hint={t("settings:help.issue.description")}
      control={<RowLink href={url} label={t("settings:help.issue.action")} testId="report-issue-link" />}
    />
  );
}

export function DiscussionsRow() {
  const { t } = useTranslation();
  return (
    <SettingRow
      label={t("settings:help.discussions.label")}
      hint={t("settings:help.discussions.description")}
      control={<RowLink href={DISCUSSIONS_URL} label={t("settings:help.discussions.action")} testId="discussions-link" />}
    />
  );
}

export function ShortcutsRow() {
  const { t } = useTranslation();
  const platform = resolveKeybindPlatform();
  const zoom = zoomBadges(platform);
  const items = [
    { id: "off", label: t("shell:keybind.modeOff"), keys: getKeybindDefinition(KEYBIND_ACTIONS.MODE_OFF, platform).badge },
    { id: "ambilight", label: t("shell:keybind.modeAmbilight"), keys: getKeybindDefinition(KEYBIND_ACTIONS.MODE_AMBILIGHT, platform).badge },
    { id: "solid", label: t("shell:keybind.modeSolid"), keys: getKeybindDefinition(KEYBIND_ACTIONS.MODE_SOLID, platform).badge },
    { id: "effect", label: t("shell:keybind.modeEffect"), keys: getKeybindDefinition(KEYBIND_ACTIONS.MODE_EFFECT, platform).badge },
    { id: "settings", label: t("shell:keybind.openSettings"), keys: getKeybindDefinition(KEYBIND_ACTIONS.OPEN_SETTINGS, platform).badge },
    { id: "zoom-in", label: t("settings:help.shortcuts.zoomIn"), keys: zoom.in },
    { id: "zoom-out", label: t("settings:help.shortcuts.zoomOut"), keys: zoom.out },
    { id: "zoom-reset", label: t("settings:help.shortcuts.zoomReset"), keys: zoom.reset },
  ];
  return (
    <SettingRow label={t("settings:help.shortcuts.label")} testId="shortcuts">
      <dl className={styles.shortcuts}>
        {items.map(({ id, label, keys }) => (
          <div key={id} className={styles.shortcut}>
            <dt>{label}</dt>
            <dd>
              {keys.map((key) => (
                <kbd key={key}>{key}</kbd>
              ))}
            </dd>
          </div>
        ))}
      </dl>
    </SettingRow>
  );
}

/** How long "Copied" stays on the button before it reads as the action again. */
const COPIED_MS = 1_800;

/**
 * The install's state as plain text for a bug report, copied at a press — never sent anywhere.
 * The shell reads it at the press, so it says what is true then.
 */
export function DiagnosticsRow({ readDiagnostics }: SettingsEnv) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return undefined;
    const timer = window.setTimeout(() => setCopied(false), COPIED_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);

  if (!readDiagnostics) return null;
  const read = readDiagnostics;

  async function copy() {
    const text = read();
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch (err) {
      console.error("[LumaSync] copying the diagnostics failed:", err);
    }
  }

  return (
    <SettingRow
      label={t("settings:help.diagnostics.label")}
      hint={t("settings:help.diagnostics.description")}
      control={
        <RowButton onClick={() => void copy()} data-testid="copy-diagnostics">
          <StateSwap
            state={copied ? "done" : "idle"}
            fit
            faces={{
              idle: t("settings:help.diagnostics.action"),
              done: (
                <>
                  <span className={styles.ok} aria-hidden="true">
                    <IconCheck />
                  </span>
                  {t("settings:help.diagnostics.copied")}
                </>
              ),
            }}
          />
        </RowButton>
      }
    >
      <p className="sr-only" role="status" aria-live="polite">
        {copied ? t("settings:help.diagnostics.copied") : ""}
      </p>
    </SettingRow>
  );
}
