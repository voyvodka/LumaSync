import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { LIGHTING_MODE_KIND, type LightingModeKind, type LitModeKind } from "@/shared/contracts/mode";
import {
  getKeybindDefinition,
  resolveKeybindPlatform,
  type KeybindAction,
} from "@/shared/contracts/shell";
import { IconPower } from "@/shared/ui/icons";
import { Segmented, type SegmentedOption } from "@/shared/ui/Segmented/Segmented";

import { LIT_MODE_ORDER, MODE_KIND_ORDER, modeKind } from "../model/modeKinds";
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

/** Off's ⌥1, said in the power button's tooltip where the tiles show theirs as badges. */
function usePowerShortcut(): string {
  const platform = useMemo(() => resolveKeybindPlatform(), []);
  return useMemo(
    () => getKeybindDefinition(modeKind(LIGHTING_MODE_KIND.OFF).keybind, platform).badge.join(""),
    [platform],
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
  /**
   * What each mode is set to, under its name where the strip has room. `key` names its form — Solid's
   * colour or white, the effect — and a new one fades in; a number moving within it just updates.
   */
  subtitles?: Partial<Record<LightingModeKind, { text: string; key: string }>>;
  /** What the power button turns back on while the lights are off. Lights and compact only. */
  lastLit?: LitModeKind;
}

/**
 * The modes. Lights and the compact window share one strip: a power button, then the modes that
 * light something as one radio group, shedding their second line and shortcut as it narrows; one
 * amber mark slides to the chosen mode. While the lights are off the mark stays on the mode the
 * power button would bring back, grey. The popup keeps its own buttons, Off among them.
 */
export function ModeStrip({
  variant,
  value,
  onSelect,
  isDisabled,
  busy = false,
  subtitles,
  lastLit = LIGHTING_MODE_KIND.AMBILIGHT,
}: ModeStripProps) {
  const { t } = useTranslation();
  // The mark lands in place first and travels only after that, so opening a page moves nothing.
  const [placed, setPlaced] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setPlaced(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  const powerShortcut = usePowerShortcut();
  // Per mode, the subtitle's form and whether it has changed since the strip opened: only a span
  // mounted for a new form carries the flag, so opening the page animates nothing.
  const forms = useRef(new Map<LightingModeKind, { key: string; changed: boolean }>());
  const subtitleOf = (kind: LightingModeKind) => {
    const sub = subtitles?.[kind];
    if (!sub) return undefined;
    const seen = forms.current.get(kind);
    if (!seen) forms.current.set(kind, { key: sub.key, changed: false });
    else if (seen.key !== sub.key) forms.current.set(kind, { key: sub.key, changed: true });
    return { ...sub, changed: forms.current.get(kind)!.changed };
  };
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

  const off = value === LIGHTING_MODE_KIND.OFF;
  const shownKind = off ? lastLit : value;
  const index = shownKind === null ? -1 : LIT_MODE_ORDER.indexOf(shownKind);
  const options = LIT_MODE_ORDER.map((kind): SegmentedOption<LightingModeKind> => {
    const { Icon, labelLang, keybind, labelKey } = modeKind(kind);
    const subtitle = variant === "full" ? subtitleOf(kind) : undefined;
    const content: ReactNode = (
      <>
        <span className={styles.icon} aria-hidden>
          <Icon />
        </span>
        <span className={styles.text}>
          <span className={styles.name} lang={labelLang}>
            {t(labelKey)}
          </span>
          {subtitle !== undefined && (
            <span key={subtitle.key} className={styles.sub} data-swapped={subtitle.changed || undefined}>
              {subtitle.text}
            </span>
          )}
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

  // Off turns the lights off; pressed while off, it brings back the mode the grey mark sits on.
  const powerTarget = off ? lastLit : LIGHTING_MODE_KIND.OFF;
  const powerLabel = off
    ? t("lights:power.turnOn", { mode: t(modeKind(lastLit).labelKey) })
    : t("lights:power.turnOff");

  return (
    <div
      className={styles.strip}
      data-variant={variant}
      data-placed={placed || undefined}
      data-off={off || undefined}
      data-busy={busy || undefined}
    >
      <button
        type="button"
        role="switch"
        aria-checked={!off}
        aria-label={t("lights:power.label")}
        // ⌥1 is Off: it is said only where the button turns the lights off.
        title={variant === "full" && !off ? `${powerLabel} (${powerShortcut})` : powerLabel}
        className={styles.power}
        data-power
        disabled={isDisabled?.(powerTarget)}
        onClick={() => select(powerTarget)}
        data-testid="mode-button-off"
      >
        <IconPower />
      </button>
      <div
        className={styles.track}
        style={{ "--n": LIT_MODE_ORDER.length, "--i": Math.max(index, 0) } as CSSProperties}
      >
        <span className={styles.mark} aria-hidden data-none={index < 0 || undefined} />
        <Segmented
          options={options}
          value={off ? null : value}
          onChange={select}
          ariaLabel={t("common:mode.title")}
          className={styles.group}
          itemClassName={styles.tile}
        />
      </div>
    </div>
  );
}
