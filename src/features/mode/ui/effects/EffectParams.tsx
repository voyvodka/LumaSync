import { useTranslation } from "react-i18next";

import {
  EFFECT_DEFAULTS,
  EFFECT_DIRECTIONS,
  EFFECT_RANGES,
  type EffectDirection,
  type EffectId,
} from "@/shared/contracts/effects";
import type { EffectPayload } from "@/shared/contracts/mode";
import { RangeRow } from "@/shared/ui/RangeRow/RangeRow";
import { Segmented } from "@/shared/ui/Segmented/Segmented";
import { StageGrid, StageRow } from "@/shared/ui/Stage/Stage";
import { paramValue, usesParam } from "../../model/effectEdits";
import styles from "./EffectControls.module.css";

const SIZE_LABEL = {
  wave: "lights:effect.sizeFor.wave",
  fireplace: "lights:effect.sizeFor.fireplace",
  gradient: "lights:effect.sizeFor.gradient",
  ocean: "lights:effect.sizeFor.ocean",
  comet: "lights:effect.sizeFor.comet",
  scanner: "lights:effect.sizeFor.scanner",
  chase: "lights:effect.sizeFor.chase",
  plasma: "lights:effect.sizeFor.plasma",
} as const satisfies Partial<Record<EffectId, string>>;

const INTENSITY_LABEL = {
  candle: "lights:effect.intensityFor.candle",
  fireplace: "lights:effect.intensityFor.fireplace",
  aurora: "lights:effect.intensityFor.aurora",
  twinkle: "lights:effect.intensityFor.twinkle",
} as const satisfies Partial<Record<EffectId, string>>;

const DIRECTION_GLYPH = {
  leftToRight: "→",
  rightToLeft: "←",
  bottomToTop: "↑",
  topToBottom: "↓",
  outward: "⤢",
  around: "↻",
} as const satisfies Record<EffectDirection, string>;

interface EffectParamsProps {
  effect: EffectPayload;
  /** Compact shows speed and brightness only. */
  compact?: boolean;
  disabled?: boolean;
  brightnessDisabled?: boolean;
  brightnessTitle?: string;
  onChange: (next: EffectPayload) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
}

const pct = (v: number) => Math.round(v * 100);

/** The running effect's own settings — only the ones it declares — and brightness. */
export function EffectParams({
  effect,
  compact = false,
  disabled = false,
  brightnessDisabled = false,
  brightnessTitle,
  onChange,
  onDragStart,
  onDragEnd,
}: EffectParamsProps) {
  const { t } = useTranslation();
  const id = effect.id;
  const variant = "stage";
  const drag = { onDragStart, onDragEnd };
  const sizeKey = (SIZE_LABEL as Partial<Record<EffectId, (typeof SIZE_LABEL)[keyof typeof SIZE_LABEL]>>)[id];
  const intensityKey = (
    INTENSITY_LABEL as Partial<Record<EffectId, (typeof INTENSITY_LABEL)[keyof typeof INTENSITY_LABEL]>>
  )[id];
  const [minMinutes, maxMinutes] = EFFECT_RANGES.durationMinutes;
  const minutes = paramValue(effect, "durationMinutes");

  return (
    <>
    <StageGrid>
      {usesParam(id, "speed") ? (
        <RangeRow
          variant={variant}
          label={t("lights:effect.speed")}
          valueLabel={`${pct(effect.speed)}%`}
          min={0}
          max={100}
          step={1}
          value={pct(effect.speed)}
          disabled={disabled}
          onChange={(v) => onChange({ ...effect, speed: v / 100 })}
          testId="effect-speed"
          {...drag}
        />
      ) : null}
      {!compact && usesParam(id, "size") ? (
        <RangeRow
          variant={variant}
          label={t(sizeKey ?? "lights:effect.size")}
          valueLabel={`${pct(paramValue(effect, "size"))}%`}
          min={0}
          max={100}
          step={1}
          value={pct(paramValue(effect, "size"))}
          disabled={disabled}
          onChange={(v) => onChange({ ...effect, size: v / 100 })}
          testId="effect-size"
          {...drag}
        />
      ) : null}
      {!compact && usesParam(id, "intensity") ? (
        <RangeRow
          variant={variant}
          label={t(intensityKey ?? "lights:effect.intensity")}
          valueLabel={`${pct(paramValue(effect, "intensity"))}%`}
          min={0}
          max={100}
          step={1}
          value={pct(paramValue(effect, "intensity"))}
          disabled={disabled}
          onChange={(v) => onChange({ ...effect, intensity: v / 100 })}
          testId="effect-intensity"
          {...drag}
        />
      ) : null}
      {usesParam(id, "durationMinutes") ? (
        <RangeRow
          variant={variant}
          label={t("lights:effect.duration")}
          valueLabel={t("lights:effect.durationValue", { count: minutes })}
          min={minMinutes}
          max={maxMinutes}
          step={1}
          value={minutes}
          disabled={disabled}
          onChange={(v) => onChange({ ...effect, durationMinutes: v })}
          testId="effect-duration"
          {...drag}
        />
      ) : null}
      <RangeRow
        variant={variant}
        label={t("lights:effect.brightness")}
        valueLabel={`${pct(effect.brightness)}%`}
        min={0}
        max={100}
        step={1}
        value={pct(effect.brightness)}
        disabled={disabled || brightnessDisabled}
        title={brightnessTitle}
        onChange={(v) => onChange({ ...effect, brightness: v / 100 })}
        testId="effect-brightness"
        {...drag}
      />
    </StageGrid>
      {!compact && usesParam(id, "direction") ? (
        <StageRow label={t("lights:effect.direction")}>
          <Segmented
            className={styles.directions}
            itemClassName={styles.directionItem}
            ariaLabel={t("lights:effect.direction")}
            value={effect.direction ?? EFFECT_DEFAULTS.direction}
            disabled={disabled}
            onChange={(direction) => onChange({ ...effect, direction })}
            options={Object.values(EFFECT_DIRECTIONS).map((direction) => ({
              value: direction,
              label: DIRECTION_GLYPH[direction],
              ariaLabel: t(`lights:effect.directions.${direction}`),
              title: t(`lights:effect.directions.${direction}`),
              testId: `effect-direction-${direction}`,
            }))}
          />
        </StageRow>
      ) : null}
    </>
  );
}
