import { useTranslation } from "react-i18next";

import { InfoTip } from "@/shared/ui/InfoTip/InfoTip";
import { StageRow } from "@/shared/ui/Stage/Stage";
import { Toggle } from "@/shared/ui/Toggle/Toggle";

interface PopupBlackBarsRowProps {
  /** What the scene crops with, as the preview session holds it. */
  enabled: boolean;
  onChange: (enabled: boolean) => void;
}

/** The Letterbox scene's black-bar switch, to see the crop at work; the scene's own, never saved.
 * It shows the session's value, which Rust sends before it answers, so a flip that did not apply
 * never moves it. */
export function PopupBlackBarsRow({ enabled, onChange }: PopupBlackBarsRowProps) {
  const { t } = useTranslation();
  return (
    <StageRow
      label={t("lights:signal.profile.blackBorder")}
      info={
        <InfoTip label={t("lights:signal.profile.blackBorderTipLabel")}>
          {t("lights:signal.profile.blackBorderTip")}
        </InfoTip>
      }
    >
      <Toggle
        checked={enabled}
        label={t("lights:signal.profile.blackBorder")}
        onChange={onChange}
        data-testid="popup-black-bars"
      />
    </StageRow>
  );
}
