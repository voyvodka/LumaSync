import { useEffect, useRef, useState } from "react";

import type { EffectPayload } from "@/shared/contracts/mode";
import { takesPalette, withEffect, withPalette } from "../../model/effectEdits";
import { EffectGallery, EffectPicker } from "./EffectGallery";
import { EffectParams } from "./EffectParams";
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

  return (
    <section className={styles.effect} data-variant={variant} data-testid="effect-controls">
      {compact ? (
        <EffectPicker effect={draft} disabled={disabled} onPick={(id) => commit(withEffect(draft, id))} />
      ) : null}
      {takesPalette(draft.id) ? (
        <PaletteStrip
          effect={draft}
          disabled={disabled}
          onPick={(palette, colors) => commit(withPalette(draft, palette, colors))}
        />
      ) : null}
      {compact ? null : (
        <EffectGallery effect={draft} disabled={disabled} onPick={(id) => commit(withEffect(draft, id))} />
      )}
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
      />
    </section>
  );
}
