import { useEffect, useRef, useState } from "react";

import type { EffectId } from "@/shared/contracts/effects";
import type { EffectPayload } from "@/shared/contracts/mode";
import { prefersReducedMotion } from "@/shared/lib/motion";
import { useArrivals } from "@/shared/lib/useArrivals";
import { useFlip } from "@/shared/lib/useFlip";
import { Stage } from "@/shared/ui/Stage/Stage";
import { takesPalette, withEffect, withPalette } from "../../model/effectEdits";
import { EffectGallery, EffectPicker } from "./EffectGallery";
import { EffectParams, effectSettingIds } from "./EffectParams";
import { PaletteStrip } from "./PaletteStrip";
import styles from "./EffectControls.module.css";

interface EffectControlsProps {
  effect: EffectPayload;
  /** Full: the gallery and every setting. Compact: a picker, the palettes, speed and brightness. */
  variant: "full" | "compact";
  disabled?: boolean;
  brightnessDisabled?: boolean;
  brightnessTitle?: string;
  /** Every change, drags included: the running effect retunes in place. */
  onChange: (next: EffectPayload) => void;
}

/** The Effect mode's controls: which effect, in which colours, and how it moves. */
export function EffectControls({
  effect,
  variant,
  disabled = false,
  brightnessDisabled = false,
  brightnessTitle,
  onChange,
}: EffectControlsProps) {
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
  const compact = variant === "compact";

  // The effect's own settings change with it: the block grows or folds to fit, a setting both
  // effects share slides to its new place, and one that is new fades in.
  const settingsRef = useRef<HTMLDivElement | null>(null);
  const palette = takesPalette(draft.id);
  const settingIds = [...(palette ? ["palettes"] : []), ...effectSettingIds(draft.id, compact)];
  useFlip(settingsRef, settingIds, { resize: true });
  const { arrived, settled } = useArrivals(settingIds);

  const pick = (id: EffectId) => {
    commit(withEffect(draft, id));
    if (compact) return;
    // Picked low on the page, the new settings can land below the fold: once the block has its new
    // height, bring it into view.
    const reduced = prefersReducedMotion();
    window.setTimeout(
      () => settingsRef.current?.scrollIntoView?.({ block: "nearest", behavior: reduced ? "auto" : "smooth" }),
      reduced ? 0 : 240,
    );
  };

  return (
    <Stage dense={compact} className={styles.effect} testId="effect-controls">
      {/* The choice of effect first: palettes come and go with the effect, and would otherwise move
          the gallery under the pointer. */}
      {compact ? (
        <EffectPicker effect={draft} disabled={disabled} onPick={pick} />
      ) : (
        <EffectGallery effect={draft} disabled={disabled} onPick={pick} />
      )}
      <div ref={settingsRef} className={styles.settings}>
        {palette ? (
          <div
            className={styles.setting}
            data-flip-id="palettes"
            data-entering={arrived.has("palettes") || undefined}
            onAnimationEnd={(event) => {
              if (event.target === event.currentTarget) settled("palettes");
            }}
          >
            <PaletteStrip
              effect={draft}
              disabled={disabled}
              onPick={(next, colors) => commit(withPalette(draft, next, colors))}
            />
          </div>
        ) : null}
        <EffectParams
        effect={draft}
        compact={compact}
        disabled={disabled}
        brightnessDisabled={brightnessDisabled}
        brightnessTitle={brightnessTitle}
        onChange={commit}
        onDragStart={() => {
          dragging.current = true;
        }}
        onDragEnd={() => {
          dragging.current = false;
        }}
        entering={arrived}
        onEntered={settled}
      />
      </div>
    </Stage>
  );
}
