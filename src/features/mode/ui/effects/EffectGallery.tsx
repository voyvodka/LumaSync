import { useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { EFFECT_ORDER, type EffectId } from "@/shared/contracts/effects";
import type { EffectPayload } from "@/shared/contracts/mode";
import { prefersReducedMotion } from "@/shared/lib/motion";
import { useFlip } from "@/shared/lib/useFlip";
import { useSideScroll } from "@/shared/lib/useSideScroll";
import { PickerList } from "@/shared/ui/PickerList/PickerList";
import { Segmented } from "@/shared/ui/Segmented/Segmented";
import { bestOnStrip, withEffect } from "../../model/effectEdits";
import { effectSwatch, paletteOf, paletteStops } from "../../model/effectSwatch";
import styles from "./EffectControls.module.css";

/** A strip's dotted line: the effect is at its best on a strip. */
function StripMark() {
  const { t } = useTranslation();
  return (
    <span className={styles.stripMark} title={t("lights:effect.bestOnStrip")} data-testid="strip-mark">
      <svg aria-hidden viewBox="0 0 12 12">
        <path d="M1.5 6h9" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        <circle cx="3" cy="6" r="1.2" fill="currentColor" />
        <circle cx="6" cy="6" r="1.2" fill="currentColor" />
        <circle cx="9" cy="6" r="1.2" fill="currentColor" />
      </svg>
      <span className="sr-only">{t("lights:effect.bestOnStripShort")}</span>
    </span>
  );
}

/**
 * A tile's picture, which changes when the palette does: the old one stays on top and fades, since
 * a gradient cannot transition in CSS. Under reduced motion it just changes.
 */
function TileSwatch({ background }: { background: string }) {
  const [layers, setLayers] = useState({ current: background, previous: null as string | null, n: 0 });
  if (background !== layers.current) {
    setLayers({ current: background, previous: prefersReducedMotion() ? null : layers.current, n: layers.n + 1 });
  }
  const { previous, n } = layers;
  return (
    <span className={styles.tileSwatch} style={{ background: layers.current }}>
      {previous !== null ? (
        <span
          key={n}
          className={styles.tileSwatchOut}
          style={{ background: previous }}
          onAnimationEnd={() => setLayers((now) => (now.n === n ? { ...now, previous: null } : now))}
        />
      ) : null}
    </span>
  );
}

/** What a tile shows: the effect in the palette it would play if picked now. */
function tileBackground(current: EffectPayload, id: EffectId): string {
  const next = withEffect(current, id);
  return effectSwatch(id, paletteStops(paletteOf(next), next));
}

interface EffectChoiceProps {
  effect: EffectPayload;
  disabled?: boolean;
  onPick: (id: EffectId) => void;
}

/**
 * Every effect as a tile, the running one ringed; a still picture each, nothing loops. As one row
 * that scrolls sideways (`row`) it leaves the height to the settings — while a scene is edited,
 * the palettes and sliders are what is being shaped. The tiles slide between the two layouts.
 */
export function EffectGallery({ effect, disabled = false, onPick, row = false }: EffectChoiceProps & { row?: boolean }) {
  const { t } = useTranslation();
  const boxRef = useRef<HTMLDivElement | null>(null);
  useFlip(boxRef, [row ? "row" : "grid", ...EFFECT_ORDER], { resize: true });
  const more = useSideScroll(boxRef, row ? "row" : "", row ? `[data-flip-id="${effect.id}"]` : undefined);
  return (
    <div ref={boxRef} className={styles.galleryBox} data-row={row || undefined} data-more={row ? more : undefined}>
      <Segmented
        className={styles.gallery}
        itemClassName={styles.tile}
        ariaLabel={t("lights:effect.label")}
        value={effect.id}
        disabled={disabled}
        onChange={onPick}
        options={EFFECT_ORDER.map((id) => ({
          value: id,
          label: (
            <>
              <TileSwatch background={tileBackground(effect, id)} />
              <span className={styles.tileName}>{t(`lights:effect.names.${id}`)}</span>
              {bestOnStrip(id) ? <StripMark /> : null}
            </>
          ),
          title: bestOnStrip(id) ? t("lights:effect.bestOnStrip") : undefined,
          testId: `effect-${id}`,
          flipId: id,
        }))}
      />
    </div>
  );
}

/** Seven rows and half of the eighth, so the list shows it scrolls; it fits under the picker in
 *  the 480px compact window. */
const COMPACT_LIST_HEIGHT = 7.5 * 32;

/** Compact's choice: the running effect as a box that opens the list. */
export function EffectPicker({ effect, disabled = false, onPick }: EffectChoiceProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const listId = useId();
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={styles.picker}
        disabled={disabled}
        aria-label={t("lights:effect.label")}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => setOpen((v) => !v)}
        data-testid="effect-picker"
      >
        <span className={styles.pickerSwatch} style={{ background: tileBackground(effect, effect.id) }} />
        <span className={styles.pickerName}>{t(`lights:effect.names.${effect.id}`)}</span>
        <svg aria-hidden viewBox="0 0 12 12" className={styles.chevron} data-open={open || undefined}>
          <path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <PickerList
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={buttonRef}
        side="below"
        id={listId}
        label={t("lights:effect.label")}
        width={196}
        maxHeight={COMPACT_LIST_HEIGHT}
        items={EFFECT_ORDER}
        itemKey={(id) => id}
        selectedIndex={EFFECT_ORDER.indexOf(effect.id)}
        renderItem={(id) => (
          <span className={styles.pickRow}>
            <span className={styles.pickerSwatch} style={{ background: tileBackground(effect, id) }} />
            <span className={styles.pickerName}>{t(`lights:effect.names.${id}`)}</span>
            {bestOnStrip(id) ? <StripMark /> : null}
          </span>
        )}
        onPick={(i) => {
          setOpen(false);
          buttonRef.current?.focus();
          const id = EFFECT_ORDER[i];
          if (id && id !== effect.id) onPick(id);
        }}
      />
    </>
  );
}
