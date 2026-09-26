import type { ComponentType } from "react";

import type { TranslationKey } from "@/features/i18n/catalogue";
import type { PreferenceKey } from "@/features/persistence/preferences";
import type { SettingsEnv } from "./settingsEnv";
import { AboutCard } from "./rows/AboutCard";
import { LanguageRow, LaunchAtLoginRow } from "./rows/GeneralRows";
import { DiscussionsRow, LogFolderRow, ReportIssueRow, SetupGuideRow, ShortcutsRow } from "./rows/HelpRows";
import { NerdStatsRow } from "./rows/NerdStatsRow";
import type { PreferenceChoiceDef } from "./rows/PreferenceChoice";
import type { PreferenceSwitchDef } from "./rows/PreferenceSwitch";
import { BetaChannelRow, UpdateCheckRow } from "./rows/UpdateRows";

/**
 * A setting is a row here and a place on a page below. A stored preference with an on/off value
 * needs no component of its own (`switch`), nor does one with a few named values (`choice`); anything
 * with its own reading, writing or result is a component that receives the whole `SettingsEnv`
 * (`custom`).
 */
export type SettingRowDef =
  | ({ kind: "switch" } & { [K in PreferenceKey]: PreferenceSwitchDef<K> }[PreferenceKey])
  | ({ kind: "choice" } & { [K in PreferenceKey]: PreferenceChoiceDef<K> }[PreferenceKey])
  | { kind: "custom"; Row: ComponentType<SettingsEnv> };

export const SETTING_ROWS = {
  launchAtLogin: { kind: "custom", Row: LaunchAtLoginRow },
  language: { kind: "custom", Row: LanguageRow },
  launchLights: {
    kind: "choice",
    pref: "launchLights",
    options: [
      { value: "resume", labelKey: "settings:launchLights.resume" },
      { value: "off", labelKey: "settings:launchLights.off" },
    ],
    labelKey: "settings:launchLights.label",
    hintKey: "settings:launchLights.hint",
    testId: "launch-lights",
  },
  closeAction: {
    kind: "choice",
    pref: "closeAction",
    options: [
      { value: "tray", labelKey: "settings:closeAction.tray" },
      { value: "quit", labelKey: "settings:closeAction.quit" },
    ],
    labelKey: "settings:closeAction.label",
    hintKey: "settings:closeAction.hint",
    testId: "close-action",
  },
  notifications: {
    kind: "switch",
    pref: "notifications",
    on: "on",
    off: "off",
    labelKey: "settings:notifications.label",
    hintKey: "settings:notifications.hint",
    testId: "notifications-toggle",
  },
  uiZoom: {
    kind: "choice",
    pref: "uiZoom",
    options: [
      { value: 90, labelKey: "settings:uiZoom.p90" },
      { value: 100, labelKey: "settings:uiZoom.p100" },
      { value: 110, labelKey: "settings:uiZoom.p110" },
      { value: 125, labelKey: "settings:uiZoom.p125" },
    ],
    labelKey: "settings:uiZoom.label",
    hintKey: "settings:uiZoom.hint",
    testId: "ui-zoom",
  },
  reduceMotion: {
    kind: "switch",
    pref: "motion",
    on: "reduce",
    off: "system",
    labelKey: "settings:motion.label",
    hintKey: "settings:motion.hint",
    testId: "reduce-motion-toggle",
  },
  nerdStats: { kind: "custom", Row: NerdStatsRow },
  updateCheck: { kind: "custom", Row: UpdateCheckRow },
  betaChannel: { kind: "custom", Row: BetaChannelRow },
  setupGuide: { kind: "custom", Row: SetupGuideRow },
  logFolder: { kind: "custom", Row: LogFolderRow },
  reportIssue: { kind: "custom", Row: ReportIssueRow },
  discussions: { kind: "custom", Row: DiscussionsRow },
  shortcuts: { kind: "custom", Row: ShortcutsRow },
  about: { kind: "custom", Row: AboutCard },
} satisfies Record<string, SettingRowDef>;

export type SettingRowId = keyof typeof SETTING_ROWS;

export type SettingsPageId = "general" | "appearance" | "updates" | "help" | "about";

interface SettingsPageDef {
  labelKey: TranslationKey;
  rows: readonly SettingRowId[];
}

/** The rail in order: a new page fails to compile until it has a row here. */
export const SETTINGS_PAGES = {
  general: { labelKey: "settings:pages.general", rows: ["launchAtLogin", "launchLights", "closeAction", "notifications", "language"] },
  appearance: { labelKey: "settings:pages.appearance", rows: ["uiZoom", "reduceMotion", "nerdStats"] },
  updates: { labelKey: "settings:pages.updates", rows: ["updateCheck", "betaChannel"] },
  help: { labelKey: "settings:pages.help", rows: ["setupGuide", "shortcuts", "logFolder", "reportIssue", "discussions"] },
  about: { labelKey: "settings:pages.about", rows: ["about"] },
} satisfies Record<SettingsPageId, SettingsPageDef>;

export const SETTINGS_PAGE_IDS = Object.keys(SETTINGS_PAGES) as SettingsPageId[];

export function settingsPage(id: SettingsPageId): SettingsPageDef {
  return SETTINGS_PAGES[id];
}

export function settingRow(id: SettingRowId): SettingRowDef {
  return SETTING_ROWS[id];
}
