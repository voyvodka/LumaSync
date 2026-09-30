import { useTranslation } from "react-i18next";

import { SOLID_KELVIN_RANGE } from "@/shared/contracts/mode";
import { kelvinToRgb } from "@/shared/lib/color";
import { RangeRow } from "@/shared/ui/RangeRow/RangeRow";

export type SolidTone = "colour" | "white";

/** Where White opens the first time: a neutral, slightly warm white. */
export const DEFAULT_WHITE_KELVIN = 4000;

const KELVIN_STEP = 50;

/** The track shows the whites it moves through, warm on the left. */
const TRACK = `linear-gradient(to right, ${[2000, 2700, 3500, 4500, 5500, 6500]
  .map((k) => {
    const { r, g, b } = kelvinToRgb(k);
    return `rgb(${r} ${g} ${b})`;
  })
  .join(", ")})`;

/** A colour temperature, as the whites it spans; the value reads in kelvin. */
export function KelvinSlider({
  kelvin,
  disabled = false,
  onChange,
}: {
  kelvin: number;
  disabled?: boolean;
  onChange: (kelvin: number) => void;
}) {
  const { t } = useTranslation();
  const { min, max } = SOLID_KELVIN_RANGE;
  const say = (k: number) => t("lights:solid.kelvinValue", { kelvin: Math.round(k / KELVIN_STEP) * KELVIN_STEP });
  return (
    <RangeRow
      variant="stage"
      label={t("lights:solid.temperature")}
      valueLabel={say}
      ariaValueText={say}
      min={min}
      max={max}
      step={KELVIN_STEP}
      value={kelvin}
      disabled={disabled}
      track={TRACK}
      onChange={(k) => onChange(Math.round(k))}
      testId="solid-kelvin"
    />
  );
}
