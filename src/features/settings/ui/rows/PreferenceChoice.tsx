import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { TranslationKey } from "@/features/i18n/catalogue";
import { setPreference, usePreference, type PreferenceKey, type PreferenceValue } from "@/features/persistence/preferences";
import { cx } from "@/shared/ui/cx";
import { Segmented } from "@/shared/ui/Segmented";
import { SettingRow } from "../SettingRow";
import styles from "./PreferenceChoice.module.css";

export interface PreferenceChoiceDef<K extends PreferenceKey = PreferenceKey> {
  pref: K;
  options: readonly { value: PreferenceValue<K>; labelKey: TranslationKey }[];
  labelKey: TranslationKey;
  hintKey?: TranslationKey;
  testId?: string;
}

/** A few named values of one stored preference, side by side. */
export function PreferenceChoice<K extends PreferenceKey>({ pref, options, labelKey, hintKey, testId }: PreferenceChoiceDef<K>) {
  const { t } = useTranslation();
  const value = usePreference(pref);
  const label = t(labelKey);
  const choose = (next: string) => {
    const picked = options.find((option) => String(option.value) === next);
    if (picked && !Object.is(picked.value, value)) void setPreference(pref, picked.value);
  };
  return (
    <SettingRow
      label={label}
      hint={hintKey ? t(hintKey) : undefined}
      testId={testId}
      control={
        <ChoiceStrip
          label={label}
          value={String(value)}
          options={options.map((option) => ({ value: String(option.value), label: t(option.labelKey) }))}
          onChange={choose}
        />
      }
    />
  );
}

export function ChoiceStrip({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string | null;
  options: readonly { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  const stripRef = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState<{ left: number; right: number; toLeft: boolean } | null>(null);
  // The first placement lands without travel: the page opens with the fill already on its value.
  const [placed, setPlaced] = useState(false);

  useLayoutEffect(() => {
    const strip = stripRef.current;
    if (!strip) return undefined;
    const measure = () => {
      if (value === null) {
        setThumb(null);
        return;
      }
      const checked = strip.querySelector<HTMLElement>('[aria-checked="true"]');
      const group = checked?.offsetParent as HTMLElement | null | undefined;
      if (!checked || !group) {
        setThumb(null);
        return;
      }
      const left = group.offsetLeft + checked.offsetLeft;
      const right = strip.clientWidth - left - checked.offsetWidth;
      setThumb((previous) => ({ left, right, toLeft: previous ? left < previous.left : false }));
    };
    measure();
    // A language switch changes the labels' widths under the fill.
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(strip);
    return () => observer?.disconnect();
  }, [value]);

  useEffect(() => {
    if (thumb && !placed) {
      const frame = requestAnimationFrame(() => setPlaced(true));
      return () => cancelAnimationFrame(frame);
    }
    return undefined;
  }, [thumb, placed]);

  return (
    <div ref={stripRef} className={styles.strip}>
      {thumb && (
        <span
          className={cx(styles.thumb, placed && styles.moving, thumb.toLeft ? styles.toLeft : styles.toRight)}
          style={{ left: thumb.left, right: thumb.right }}
          aria-hidden="true"
        />
      )}
      <Segmented
        className={styles.group}
        itemClassName={styles.item}
        ariaLabel={label}
        value={value}
        onChange={onChange}
        options={options.map((o) => ({ value: o.value, label: o.label, testId: `choice-${o.value}` }))}
      />
    </div>
  );
}
