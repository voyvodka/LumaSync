import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { RangeRow } from "@/shared/ui/RangeRow/RangeRow";

interface PopupBrightnessRowProps {
  /** 0..1, as the running mode holds it. */
  brightness: number;
  disabled?: boolean;
  onChange: (brightness: number) => void;
}

/** The running mode's brightness. A drag keeps its own value until it ends, so a slower answer
 * from the runtime does not pull the thumb back under the pointer. */
export function PopupBrightnessRow({ brightness, disabled = false, onChange }: PopupBrightnessRowProps) {
  const { t } = useTranslation();
  const [percent, setPercent] = useState(() => Math.round(brightness * 100));
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (!dragging) setPercent(Math.round(brightness * 100));
  }, [dragging, brightness]);

  return (
    <RangeRow
      variant="stage"
      label={t("common:mode.brightness")}
      valueLabel={`${percent}%`}
      min={0}
      max={100}
      step={1}
      value={percent}
      disabled={disabled}
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
