import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { useThrottledCommit } from "@/shared/lib/useThrottledCommit";
import { RangeRow } from "@/shared/ui/RangeRow";

const BRIGHTNESS_COMMIT_MIN_INTERVAL_MS = 50;

/** Throttled range input. `initialPercent` re-syncs on external drift, but only
 *  while the user is not dragging — otherwise an echo commit snaps the thumb. */

interface SelfContainedBrightnessRowProps {
  initialPercent: number;
  disabled: boolean;
  /**
   * Mono mini-notice rendered under the slider when the row is disabled
   * for a firmware-level reason (Adalight, primarily). Mirrors the
   * SolidColorPanel surface in full mode so users see the same copy
   * regardless of which window they're in.
   */
  brightnessDisabledReason?: string;
  onCommit: (next: number) => void;
}

export function SelfContainedBrightnessRow({
  initialPercent,
  disabled,
  brightnessDisabledReason,
  onCommit,
}: SelfContainedBrightnessRowProps) {
  const { t } = useTranslation();
  const [localPercent, setLocalPercent] = useState(initialPercent);
  const isDraggingRef = useRef(false);
  const throttle = useThrottledCommit<number>((percent) => onCommit(percent / 100), BRIGHTNESS_COMMIT_MIN_INTERVAL_MS);

  useEffect(() => {
    if (isDraggingRef.current) return;
    setLocalPercent(initialPercent);
    throttle.sync(initialPercent);
  }, [initialPercent, throttle]);

  return (
    <RangeRow
      variant="compact"
      label={t("common:mode.brightness")}
      valueLabel={`${localPercent}%`}
      min={0}
      max={100}
      step={1}
      value={localPercent}
      disabled={disabled}
      title={brightnessDisabledReason}
      note={brightnessDisabledReason}
      onDragStart={() => {
        isDraggingRef.current = true;
      }}
      onDragEnd={() => {
        isDraggingRef.current = false;
        throttle.flush();
      }}
      onChange={(next) => {
        setLocalPercent(next);
        throttle.push(next);
      }}
    />
  );
}
