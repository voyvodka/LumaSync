import { useId } from "react";
import { useTranslation } from "react-i18next";

import { HUE_OFF_BEHAVIOR, type HueOffBehavior } from "@/shared/contracts/hue";
import { Segmented } from "@/shared/ui/Segmented";

const ORDER: readonly HueOffBehavior[] = [HUE_OFF_BEHAVIOR.TURN_OFF, HUE_OFF_BEHAVIOR.RESTORE];

export interface HueOffBehaviorControlProps {
  /** `null` until the saved value is known, so a saved "go back" never shows
   *  "turn off" first. */
  value: HueOffBehavior | null;
  onChange: (next: HueOffBehavior) => void;
}

/**
 * What pressing Off does to the Hue lights. The parent only saves it: Rust
 * reads the saved value when an Off runs, so nothing reaches the running mode.
 */
export function HueOffBehaviorControl({ value, onChange }: HueOffBehaviorControlProps) {
  const { t } = useTranslation();
  const descriptionId = useId();
  const labels: Record<HueOffBehavior, string> = {
    [HUE_OFF_BEHAVIOR.TURN_OFF]: t("hue:offBehavior.turnOff"),
    [HUE_OFF_BEHAVIOR.RESTORE]: t("hue:offBehavior.restore"),
  };
  const title = t("hue:offBehavior.title");

  return (
    <div className="lm-hue-off-form">
      {/* The radiogroup carries the same words as its name; read once. */}
      <div className="lm-hue-ip-form-title" aria-hidden="true">
        {title}
      </div>
      <Segmented
        className="lm-settings-seg"
        ariaLabel={title}
        ariaDescribedBy={descriptionId}
        value={value}
        onChange={(next) => {
          if (next !== value) onChange(next);
        }}
        options={ORDER.map((candidate) => ({
          value: candidate,
          label: labels[candidate],
          testId: `hue-off-behavior-${candidate}`,
        }))}
      />
      <div className="lm-hue-ip-form-sub" id={descriptionId}>
        {t("hue:offBehavior.description")}
      </div>
    </div>
  );
}
