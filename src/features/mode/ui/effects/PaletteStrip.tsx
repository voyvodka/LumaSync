import { useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { EFFECT_RANGES, PALETTE_IDS, PALETTE_ORDER, type PaletteId } from "@/shared/contracts/effects";
import type { EffectColor, EffectPayload } from "@/shared/contracts/mode";
import { HsvColorPicker } from "@/shared/ui/HsvColorPicker/HsvColorPicker";
import { IconClose } from "@/shared/ui/icons";
import { Popover } from "@/shared/ui/Popover/Popover";
import { Segmented } from "@/shared/ui/Segmented/Segmented";
import { colorToHex, customColorsOf, hexToColor, paletteOf, paletteSwatch } from "../../model/effectSwatch";
import styles from "./EffectControls.module.css";

interface PaletteStripProps {
  effect: EffectPayload;
  disabled?: boolean;
  onPick: (palette: PaletteId, colors?: EffectColor[]) => void;
}

/**
 * The palettes as swatches. "Your colours" is the last one; once it plays, a pen beside it opens
 * the colours in a popover — the strip itself never grows.
 */
export function PaletteStrip({ effect, disabled = false, onPick }: PaletteStripProps) {
  const { t } = useTranslation();
  const current = paletteOf(effect);
  const [editing, setEditing] = useState(false);
  const editRef = useRef<HTMLButtonElement | null>(null);
  const editorId = useId();
  const custom = current === PALETTE_IDS.CUSTOM;

  return (
    <div className={styles.paletteRow}>
      <Segmented
        className={styles.palettes}
        itemClassName={styles.palette}
        ariaLabel={t("lights:effect.palette")}
        value={current}
        disabled={disabled}
        onChange={(palette) => onPick(palette, palette === PALETTE_IDS.CUSTOM ? customColorsOf(effect) : undefined)}
        options={PALETTE_ORDER.map((palette) => ({
          value: palette,
          label: <span className={styles.paletteDot} style={{ background: paletteSwatch(palette, effect) }} />,
          ariaLabel: t(`lights:effect.palettes.${palette}`),
          title: t(`lights:effect.palettes.${palette}`),
          testId: `palette-${palette}`,
        }))}
      />
      <button
        ref={editRef}
        type="button"
        className={styles.edit}
        data-shown={custom || undefined}
        disabled={!custom || disabled}
        tabIndex={custom ? undefined : -1}
        aria-hidden={custom ? undefined : true}
        aria-label={t("lights:effect.colors")}
        aria-haspopup="dialog"
        aria-expanded={editing}
        aria-controls={editing ? editorId : undefined}
        onClick={() => setEditing((open) => !open)}
        data-testid="palette-edit"
      >
        <svg aria-hidden viewBox="0 0 12 12">
          <path d="M2 10h2.2L10 4.2 7.8 2 2 7.8z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
        </svg>
      </button>
      <Popover
        open={editing && custom}
        onClose={() => setEditing(false)}
        anchorRef={editRef}
        side="below"
        width={248}
        id={editorId}
        role="dialog"
        label={t("lights:effect.colors")}
      >
        <CustomColors
          colors={customColorsOf(effect)}
          onChange={(colors) => onPick(PALETTE_IDS.CUSTOM, colors)}
        />
      </Popover>
    </div>
  );
}

function CustomColors({ colors, onChange }: { colors: EffectColor[]; onChange: (colors: EffectColor[]) => void }) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState(0);
  const index = Math.max(0, Math.min(selected, colors.length - 1));
  const current = colors[index] ?? { r: 255, g: 255, b: 255 };
  const [min, max] = EFFECT_RANGES.colors;

  const replace = (at: number, color: EffectColor) => onChange(colors.map((c, i) => (i === at ? color : c)));

  return (
    <div className={styles.custom} data-testid="custom-colors">
      <div className={styles.chips}>
        {colors.map((color, i) => (
          <span key={i} className={styles.chipWrap}>
            <button
              type="button"
              className={styles.chip}
              style={{ background: colorToHex(color) }}
              aria-pressed={i === index}
              aria-label={t("lights:effect.colorN", { n: i + 1 })}
              onClick={() => setSelected(i)}
            />
            {colors.length > min && i === index ? (
              <button
                type="button"
                className={styles.chipRemove}
                aria-label={t("lights:effect.removeColor")}
                onClick={() => {
                  onChange(colors.filter((_, j) => j !== i));
                  setSelected(Math.max(0, i - 1));
                }}
              >
                <IconClose />
              </button>
            ) : null}
          </span>
        ))}
        {colors.length < max ? (
          <button
            type="button"
            className={styles.chipAdd}
            aria-label={t("lights:effect.addColor")}
            onClick={() => {
              onChange([...colors, current]);
              setSelected(colors.length);
            }}
          >
            +
          </button>
        ) : null}
      </div>
      <HsvColorPicker
        compact
        hideRecent
        value={colorToHex(current)}
        ariaLabel={t("lights:effect.colorN", { n: index + 1 })}
        onChange={(hex) => replace(index, hexToColor(hex))}
      />
    </div>
  );
}
