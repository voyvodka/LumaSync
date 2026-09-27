import { useTranslation } from "react-i18next";

import type { TranslationKey } from "@/features/i18n/catalogue";
import { setPreference, usePreference, type PreferenceKey, type PreferenceValue } from "@/features/persistence/preferences";
import { ChoiceStrip } from "@/shared/ui/ChoiceStrip/ChoiceStrip";
import { SettingRow } from "@/shared/ui/SettingRow/SettingRow";

export interface PreferenceChoiceDef<K extends PreferenceKey = PreferenceKey> {
  pref: K;
  options: readonly { value: PreferenceValue<K>; labelKey: TranslationKey }[];
  labelKey: TranslationKey;
  hintKey?: TranslationKey;
  testId?: string;
}

/** A few named values of one stored preference, side by side. */
export function PreferenceChoice<K extends PreferenceKey>({ pref, options, labelKey, hintKey, testId }: PreferenceChoiceDef<K>) {
  const { t } = useTranslation();
  const value = usePreference(pref);
  const label = t(labelKey);
  const choose = (next: string) => {
    const picked = options.find((option) => String(option.value) === next);
    if (picked && !Object.is(picked.value, value)) void setPreference(pref, picked.value);
  };
  return (
    <SettingRow
      label={label}
      hint={hintKey ? t(hintKey) : undefined}
      testId={testId}
      control={
        <ChoiceStrip
          label={label}
          value={String(value)}
          options={options.map((option) => ({ value: String(option.value), label: t(option.labelKey) }))}
          onChange={choose}
        />
      }
    />
  );
}
