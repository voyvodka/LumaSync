import { useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { TranslationKey } from "@/features/i18n/catalogue";
import { toneCss } from "@/features/room-view/model/furnitureModel";
import type { FurnitureTone } from "@/shared/contracts/roomMap";
import { cx } from "@/shared/lib/cx";
import { Popover } from "@/shared/ui/Popover/Popover";
import { Segmented } from "@/shared/ui/Segmented/Segmented";

import { ZONE_SWATCH_NAMES, ZONE_TOKENS, type ZoneSwatchName, zoneSwatchIndex } from "../../model/zoneColor";
import { IconChevronUp } from "./dockIcons";
import styles from "./DockSwatches.module.css";

const DEFAULT_TONE = "default";

/** A piece's tone as one disc that opens its swatches above it. The list stays open while you try
 *  them — each pick lands at once — and closes on Esc or a press elsewhere. */
export function TonePicker({
  value,
  tones,
  onChange,
  disabled = false,
}: {
  value: FurnitureTone | undefined;
  tones: readonly FurnitureTone[];
  onChange: (tone: FurnitureTone | undefined) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const popoverId = useId();
  const name = value ? t(`roomMap:furniture.tone.${value}`) : t("roomMap:inspector.toneDefault");

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className={cx(styles.button, open && styles.open)}
        aria-label={`${t("roomMap:inspector.toneLabel")}: ${name}`}
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        title={name}
        disabled={disabled}
        onClick={() => setOpen((was) => !was)}
      >
        <span className={cx(styles.disc, !value && styles.discDefault)} style={value ? { background: toneCss(value) } : undefined} />
        <span className={styles.chevron}>
          <IconChevronUp />
        </span>
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchorRef={anchorRef} side="above" width="fit" id={popoverId} label={t("roomMap:inspector.toneLabel")} role="dialog">
        <Segmented
          className={styles.row}
          ariaLabel={t("roomMap:inspector.toneLabel")}
          value={value ?? DEFAULT_TONE}
          options={[
            {
              value: DEFAULT_TONE,
              label: <span className={cx(styles.disc, styles.discDefault)} aria-hidden="true" />,
              ariaLabel: t("roomMap:inspector.toneDefault"),
              title: t("roomMap:inspector.toneDefault"),
              className: styles.swatch,
            },
            ...tones.map((tone) => ({
              value: tone,
              label: <span className={styles.disc} style={{ background: toneCss(tone) }} aria-hidden="true" />,
              ariaLabel: t(`roomMap:furniture.tone.${tone}`),
              title: t(`roomMap:furniture.tone.${tone}`),
              className: styles.swatch,
            })),
          ]}
          onChange={(next) => onChange(next === DEFAULT_TONE ? undefined : (next as FurnitureTone))}
        />
      </Popover>
    </>
  );
}

const SWATCH_LABEL = {
  blue: "roomMap:zoneProperties.swatch.blue",
  emerald: "roomMap:zoneProperties.swatch.emerald",
  purple: "roomMap:zoneProperties.swatch.purple",
  amber: "roomMap:zoneProperties.swatch.amber",
  rose: "roomMap:zoneProperties.swatch.rose",
  cyan: "roomMap:zoneProperties.swatch.cyan",
} as const satisfies Record<ZoneSwatchName, TranslationKey>;

/** A zone's colour as the six palette discs in a row. A colour of the user's own marks none and is
 *  kept until a disc is pressed. */
export function ZoneSwatches({ value, onChange }: { value: string | null | undefined; onChange: (token: string) => void }) {
  const { t } = useTranslation();
  const index = zoneSwatchIndex(value);
  return (
    <Segmented
      className={styles.inline}
      ariaLabel={t("roomMap:zoneProperties.color")}
      value={index >= 0 ? ZONE_TOKENS[index]! : null}
      options={ZONE_SWATCH_NAMES.map((name, i) => ({
        value: ZONE_TOKENS[i]!,
        label: <span className={styles.disc} style={{ background: ZONE_TOKENS[i] }} aria-hidden="true" />,
        ariaLabel: t(SWATCH_LABEL[name]),
        title: t(SWATCH_LABEL[name]),
        className: styles.swatch,
      }))}
      onChange={onChange}
    />
  );
}
