import { useTranslation } from "react-i18next";

import { EFFECT_IDS, type EffectId } from "@/shared/contracts/effects";
import { Segmented } from "@/shared/ui/Segmented/Segmented";

import styles from "./ControlPopupApp.module.css";

/** A short list to try from the popup; the whole gallery, palettes and speed stay on Lights. */
export const POPUP_EFFECTS: readonly EffectId[] = [
  EFFECT_IDS.WAVE,
  EFFECT_IDS.CYCLE,
  EFFECT_IDS.BREATHE,
  EFFECT_IDS.CANDLE,
  EFFECT_IDS.AURORA,
  EFFECT_IDS.TWINKLE,
];

interface PopupEffectListProps {
  running: EffectId;
  onPick: (id: EffectId) => void;
}

/** The running effect is always on the list: one chosen on Lights comes after the six, which keep
 * their places so a pick never moves a chip under the pointer. */
export function PopupEffectList({ running, onPick }: PopupEffectListProps) {
  const { t } = useTranslation();
  const ids = POPUP_EFFECTS.includes(running) ? POPUP_EFFECTS : [...POPUP_EFFECTS, running];
  return (
    <Segmented
      options={ids.map((id) => ({ value: id, label: t(`lights:effect.names.${id}`) }))}
      value={running}
      onChange={onPick}
      ariaLabel={t("common:mode.options.effect")}
      className={styles.effects}
      itemClassName={styles.effect}
    />
  );
}
