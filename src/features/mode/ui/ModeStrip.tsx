import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import type { LightingModeKind } from "@/shared/contracts/mode";
import {
  getKeybindDefinition,
  resolveKeybindPlatform,
  type KeybindAction,
} from "@/shared/contracts/shell";
import { Segmented, type SegmentedOption } from "@/shared/ui/Segmented/Segmented";

import { MODE_KIND_ORDER, modeKind } from "../model/modeKinds";
import styles from "./ModeStrip.module.css";

export type ModeStripVariant = "full" | "compact" | "popup";

/** Badge text comes from `KEYBIND_REGISTRY`, the same table `useGlobalKeybinds` reads. */
function ModeKeybindBadge({ action }: { action: KeybindAction }) {
  const platform = useMemo(() => resolveKeybindPlatform(), []);
  const definition = useMemo(() => getKeybindDefinition(action, platform), [action, platform]);
  return (
    <span className={styles.badge} data-part="keybind">
      {definition.badge.join("")}
    </span>
  );
}

interface ModeStripProps {
  variant: ModeStripVariant;
  /** `null` checks nothing — the popup while a test pattern owns the light. */
  value: LightingModeKind | null;
  onSelect: (kind: LightingModeKind) => void;
  isDisabled?: (kind: LightingModeKind) => boolean;
  /**
   * A choice is in flight: a press is ignored until it lands, but nothing dims. Ambilight takes a
   * few hundred milliseconds to start capture, and a strip that greyed out for it read as a stall.
   */
  busy?: boolean;
  /** What each mode is set to, under its name where the strip has room. */
  subtitles?: Partial<Record<LightingModeKind, string>>;
}

/**
 * The modes as one radio group. Lights and the compact window share one strip that sheds its
 * second line and shortcut as it narrows; one amber mark slides to the chosen mode. The popup keeps
 * its own buttons.
 */
export function ModeStrip({ variant, value, onSelect, isDisabled, busy = false, subtitles }: ModeStripProps) {
  const { t } = useTranslation();
  // The mark lands in place first and travels only after that, so opening a page moves nothing.
  const [placed, setPlaced] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setPlaced(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  const select = (kind: LightingModeKind) => {
    if (!busy) onSelect(kind);
  };

  if (variant === "popup") {
    return (
      <Segmented
        options={MODE_KIND_ORDER.map((kind) => {
          const { PopupIcon, labelLang, labelKey } = modeKind(kind);
          return {
            value: kind,
            label: (
              <>
                <span aria-hidden="true">
                  <PopupIcon />
                </span>
                <span lang={labelLang}>{t(labelKey)}</span>
              </>
            ),
            disabled: isDisabled?.(kind),
          };
        })}
        value={value}
        onChange={select}
        ariaLabel={t("common:mode.title")}
        className="lm-control-mode-strip"
        itemClassName="lm-control-mbtn"
      />
    );
  }

  const index = value === null ? -1 : MODE_KIND_ORDER.indexOf(value);
  const options = MODE_KIND_ORDER.map((kind): SegmentedOption<LightingModeKind> => {
    const { Icon, labelLang, keybind, labelKey } = modeKind(kind);
    const subtitle = variant === "full" ? subtitles?.[kind] : undefined;
    const content: ReactNode = (
      <>
        <span className={styles.icon} aria-hidden>
          <Icon />
        </span>
        <span className={styles.text}>
          <span className={styles.name} lang={labelLang}>
            {t(labelKey)}
          </span>
          {subtitle !== undefined && <span className={styles.sub}>{subtitle}</span>}
        </span>
        {variant === "full" && <ModeKeybindBadge action={keybind} />}
      </>
    );
    return {
      value: kind,
      label: content,
      disabled: isDisabled?.(kind),
      testId: `mode-button-${kind}`,
    };
  });

  return (
    <div
      className={styles.strip}
      data-variant={variant}
      data-placed={placed || undefined}
      data-busy={busy || undefined}
      aria-busy={busy || undefined}
      style={{ "--n": MODE_KIND_ORDER.length, "--i": Math.max(index, 0) } as CSSProperties}
    >
      <span className={styles.mark} aria-hidden data-none={index < 0 || undefined} />
      <Segmented
        options={options}
        value={value}
        onChange={select}
        ariaLabel={t("common:mode.title")}
        className={styles.group}
        itemClassName={styles.tile}
      />
    </div>
  );
}
