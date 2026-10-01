import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import type { EffectPayload } from "@/shared/contracts/mode";
import { RangeRow } from "@/shared/ui/RangeRow/RangeRow";

interface PopupEffectRowProps {
  effect: EffectPayload;
  onBrightness: (brightness: number) => void;
}

/** The running effect's name and brightness; the rest of it is chosen on Lights. */
export function PopupEffectRow({ effect, onBrightness }: PopupEffectRowProps) {
  const { t } = useTranslation();
  const [percent, setPercent] = useState(() => Math.round(effect.brightness * 100));
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (!dragging) setPercent(Math.round(effect.brightness * 100));
  }, [dragging, effect.brightness]);

  return (
    <div data-testid="popup-effect">
      <RangeRow
        variant="stage"
        label={t(`lights:effect.names.${effect.id}`)}
        ariaLabel={t("common:mode.brightness")}
        valueLabel={`${percent}%`}
        min={0}
        max={100}
        step={1}
        value={percent}
        onDragStart={() => setDragging(true)}
        onDragEnd={() => setDragging(false)}
        onChange={(next) => {
          setPercent(next);
          onBrightness(next / 100);
        }}
      />
    </div>
  );
}
