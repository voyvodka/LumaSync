import { useTranslation } from "react-i18next";

import type { TranslationKey } from "@/features/i18n/catalogue";
import { setPreference, usePreference, type PreferenceKey, type PreferenceValue } from "@/features/persistence/preferences";
import { Toggle } from "@/shared/ui/Toggle";
import { SettingRow } from "@/shared/ui/SettingRow/SettingRow";

export interface PreferenceSwitchDef<K extends PreferenceKey = PreferenceKey> {
  pref: K;
  /** The stored value the switch writes when turned on, and when turned off. */
  on: PreferenceValue<K>;
  off: PreferenceValue<K>;
  labelKey: TranslationKey;
  hintKey?: TranslationKey;
  testId?: string;
}

/** A switch over one stored preference. */
export function PreferenceSwitch<K extends PreferenceKey>({ pref, on, off, labelKey, hintKey, testId }: PreferenceSwitchDef<K>) {
  const { t } = useTranslation();
  const value = usePreference(pref);
  const label = t(labelKey);
  return (
    <SettingRow
      label={label}
      hint={hintKey ? t(hintKey) : undefined}
      control={
        <Toggle
          checked={Object.is(value, on)}
          onChange={(next) => {
            void setPreference(pref, next ? on : off);
          }}
          label={label}
          data-testid={testId}
        />
      }
    />
  );
}
