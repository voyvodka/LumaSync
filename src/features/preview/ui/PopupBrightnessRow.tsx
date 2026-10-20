import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { RangeRow } from "@/shared/ui/RangeRow/RangeRow";

interface PopupBrightnessRowProps {
  /** 0..1, as the preview session holds it. */
  brightness: number;
  onChange: (brightness: number) => void;
}

/** The playing scene's brightness. A drag keeps its own value until it ends, so a slower answer
 * from the session does not pull the thumb back under the pointer. */
export function PopupBrightnessRow({ brightness, onChange }: PopupBrightnessRowProps) {
  const { t } = useTranslation();
  const [percent, setPercent] = useState(() => Math.round(brightness * 100));
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (!dragging) setPercent(Math.round(brightness * 100));
  }, [dragging, brightness]);

  return (
    <RangeRow
      label={t("common:mode.brightness")}
      valueLabel={`${percent}%`}
      min={0}
      max={100}
      step={1}
      value={percent}
      onDragStart={() => setDragging(true)}
      onDragEnd={() => setDragging(false)}
      onChange={(next) => {
        setPercent(next);
        onChange(next / 100);
      }}
      testId="popup-brightness"
    />
  );
}
