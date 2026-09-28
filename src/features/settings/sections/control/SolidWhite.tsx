import { useTranslation } from "react-i18next";

import { SOLID_KELVIN_RANGE } from "@/shared/contracts/mode";
import { kelvinToRgb } from "@/shared/lib/color";
import { Segmented } from "@/shared/ui/Segmented/Segmented";
import styles from "./SolidWhite.module.css";

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

export function SolidToneTabs({
  tone,
  disabled = false,
  onChange,
}: {
  tone: SolidTone;
  disabled?: boolean;
  onChange: (tone: SolidTone) => void;
}) {
  const { t } = useTranslation();
  return (
    <Segmented
      className={styles.tabs}
      itemClassName={styles.tab}
      ariaLabel={t("lights:solid.tone")}
      value={tone}
      disabled={disabled}
      onChange={onChange}
      options={[
        { value: "colour", label: t("lights:solid.colour"), testId: "solid-tone-colour" },
        { value: "white", label: t("lights:solid.white"), testId: "solid-tone-white" },
      ]}
    />
  );
}

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
  return (
    <div className={styles.kelvin}>
      <div className={styles.row}>
        <span>{t("lights:solid.temperature")}</span>
        <b>{t("lights:solid.kelvinValue", { kelvin })}</b>
      </div>
      <input
        type="range"
        className={styles.track}
        style={{ background: TRACK }}
        min={min}
        max={max}
        step={KELVIN_STEP}
        value={kelvin}
        disabled={disabled}
        aria-label={t("lights:solid.temperature")}
        aria-valuetext={t("lights:solid.kelvinValue", { kelvin })}
        onChange={(e) => onChange(Number.parseInt(e.currentTarget.value, 10))}
        data-testid="solid-kelvin"
      />
    </div>
  );
}
