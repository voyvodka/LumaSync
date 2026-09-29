import type { ReactNode } from "react";
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
  /** Settings that have just appeared with a new effect: they fade in. */
  entering?: ReadonlySet<string>;
  onEntered?: (id: string) => void;
}

const pct = (v: number) => Math.round(v * 100);

/**
 * The settings an effect shows, in order, as the ids its cells carry: what changes when the effect
 * does, so the block can grow or fold to fit and a setting both effects share can slide.
 */
export function effectSettingIds(id: EffectId, compact: boolean): string[] {
  const shown = (param: "speed" | "size" | "intensity" | "durationMinutes" | "direction", full = false) =>
    usesParam(id, param) && (!full || !compact);
  return [
    ...(shown("speed") ? ["speed"] : []),
    ...(shown("size", true) ? ["size"] : []),
    ...(shown("intensity", true) ? ["intensity"] : []),
    ...(shown("durationMinutes") ? ["durationMinutes"] : []),
    "brightness",
    ...(shown("direction", true) ? ["direction"] : []),
  ];
}

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
  entering,
  onEntered,
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
  // One cell per setting, carrying its id: it slides when the effect changes, and fades in when new.
  const cell = (key: string, node: ReactNode) => (
    <div
      key={key}
      className={styles.setting}
      data-flip-id={key}
      data-entering={entering?.has(key) || undefined}
      onAnimationEnd={(event) => {
        if (event.target === event.currentTarget) onEntered?.(key);
      }}
    >
      {node}
    </div>
  );

  return (
    <>
      <StageGrid>
        {usesParam(id, "speed")
          ? cell(
              "speed",
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
              />,
            )
          : null}
        {!compact && usesParam(id, "size")
          ? cell(
              "size",
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
              />,
            )
          : null}
        {!compact && usesParam(id, "intensity")
          ? cell(
              "intensity",
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
              />,
            )
          : null}
        {usesParam(id, "durationMinutes")
          ? cell(
              "durationMinutes",
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
              />,
            )
          : null}
        {cell(
          "brightness",
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
          />,
        )}
      </StageGrid>
      {!compact && usesParam(id, "direction")
        ? cell(
            "direction",
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
            </StageRow>,
          )
        : null}
    </>
  );
}
