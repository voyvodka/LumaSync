import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { EFFECT_IDS, type EffectId, type EffectPayload } from "@/shared/contracts/mode";
import { RangeRow } from "@/shared/ui/RangeRow/RangeRow";
import { Segmented } from "@/shared/ui/Segmented/Segmented";

const EFFECT_ORDER = [EFFECT_IDS.RAINBOW, EFFECT_IDS.BREATHE, EFFECT_IDS.CYCLE] as const satisfies readonly EffectId[];

const EFFECT_NAME_KEY = {
  rainbow: "lights:effect.names.rainbow",
  breathe: "lights:effect.names.breathe",
  cycle: "lights:effect.names.cycle",
} as const satisfies Record<EffectId, string>;

interface EffectPanelProps {
  effect: EffectPayload;
  disabled?: boolean;
  /** Every change, drags included: the running effect retunes in place. */
  onChange: (next: EffectPayload) => void;
}

/**
 * The running effect's choice, speed and brightness. A stand-in in the Ambilight slab's own rows
 * until the Lights page is redesigned around its modes.
 */
export function EffectPanel({ effect, disabled = false, onChange }: EffectPanelProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(effect);
  const dragging = useRef(false);

  // What runs wins, except under a drag: the snapshot trails the pointer.
  useEffect(() => {
    if (!dragging.current) setDraft(effect);
  }, [effect]);

  const commit = (next: EffectPayload) => {
    setDraft(next);
    onChange(next);
  };
  const speedPct = Math.round(draft.speed * 100);
  const brightnessPct = Math.round(draft.brightness * 100);
  const drag = {
    onDragStart: () => {
      dragging.current = true;
    },
    onDragEnd: () => {
      dragging.current = false;
    },
  };

  return (
    <div className="lm-signal" data-testid="effect-panel">
      <div className="lm-psl lm-psl-seg">
        <div className="row">
          <span>{t("lights:effect.label")}</span>
          <b>{t(EFFECT_NAME_KEY[draft.id])}</b>
        </div>
        <Segmented
          className="lm-settings-seg"
          ariaLabel={t("lights:effect.label")}
          value={draft.id}
          disabled={disabled}
          onChange={(id) => commit({ ...draft, id })}
          options={EFFECT_ORDER.map((id) => ({ value: id, label: t(EFFECT_NAME_KEY[id]), testId: `effect-${id}` }))}
        />
      </div>
      <div className="lm-profile">
        <RangeRow
          variant="profile"
          label={t("lights:effect.speed")}
          valueLabel={`${speedPct}%`}
          min={0}
          max={100}
          step={1}
          value={speedPct}
          disabled={disabled}
          onChange={(value) => commit({ ...draft, speed: value / 100 })}
          testId="effect-speed"
          {...drag}
        />
        <RangeRow
          variant="profile"
          label={t("lights:effect.brightness")}
          valueLabel={`${brightnessPct}%`}
          min={0}
          max={100}
          step={1}
          value={brightnessPct}
          disabled={disabled}
          onChange={(value) => commit({ ...draft, brightness: value / 100 })}
          testId="effect-brightness"
          {...drag}
        />
      </div>
    </div>
  );
}
