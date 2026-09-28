import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import type { EffectPayload } from "@/shared/contracts/mode";

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
      <div className="lm-control-section-title flex items-center justify-between">
        <span>{t(`lights:effect.names.${effect.id}`)}</span>
        <span className="font-mono text-[10px] text-ink-dim">
          <span className="lm-control-readout-num">{percent}%</span>
        </span>
      </div>
      <label className="block w-full">
        <span className="sr-only">{t("common:mode.brightness")}</span>
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={percent}
          aria-label={t("common:mode.brightness")}
          className="h-2 w-full cursor-pointer appearance-none rounded-full"
          style={{
            accentColor: "var(--lm-amber)",
            background: `linear-gradient(to right, var(--lm-amber) 0%, var(--lm-amber) ${percent}%, var(--lm-line-2) ${percent}%, var(--lm-line-2) 100%)`,
          }}
          onPointerDown={() => setDragging(true)}
          onPointerUp={() => setDragging(false)}
          onBlur={() => setDragging(false)}
          onChange={(e) => {
            const next = Number.parseInt(e.currentTarget.value, 10);
            setPercent(next);
            onBrightness(next / 100);
          }}
        />
      </label>
    </div>
  );
}
