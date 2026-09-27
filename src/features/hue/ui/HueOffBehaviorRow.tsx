import { useTranslation } from "react-i18next";

import { HUE_OFF_BEHAVIOR, type HueOffBehavior } from "@/shared/contracts/hue";
import { ChoiceStrip } from "@/shared/ui/ChoiceStrip/ChoiceStrip";
import { SettingRow } from "@/shared/ui/SettingRow/SettingRow";

const ORDER: readonly HueOffBehavior[] = [HUE_OFF_BEHAVIOR.TURN_OFF, HUE_OFF_BEHAVIOR.RESTORE];

export interface HueOffBehaviorRowProps {
  /** `null` until the saved value is known, so a saved "go back" never shows "turn off" first. */
  value: HueOffBehavior | null;
  onChange: (next: HueOffBehavior) => void;
}

/**
 * What pressing Off does to the Hue lights. The parent only saves it: Rust reads the saved value
 * when an Off runs, so nothing reaches the running mode.
 */
export function HueOffBehaviorRow({ value, onChange }: HueOffBehaviorRowProps) {
  const { t } = useTranslation();
  const labels: Record<HueOffBehavior, string> = {
    [HUE_OFF_BEHAVIOR.TURN_OFF]: t("hue:offBehavior.turnOff"),
    [HUE_OFF_BEHAVIOR.RESTORE]: t("hue:offBehavior.restore"),
  };

  return (
    <SettingRow
      label={t("hue:row.offBehavior")}
      hint={t("hue:offBehavior.description")}
      control={
        <ChoiceStrip
          label={t("hue:offBehavior.title")}
          value={value}
          testIdPrefix="hue-off-behavior-"
          options={ORDER.map((candidate) => ({ value: candidate, label: labels[candidate] }))}
          onChange={(next) => {
            const picked = ORDER.find((candidate) => candidate === next);
            if (picked && picked !== value) onChange(picked);
          }}
        />
      }
    />
  );
}
