import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { cx } from "@/shared/ui/cx";
import { InfoTip } from "@/shared/ui/InfoTip/InfoTip";
import { Menu } from "@/shared/ui/Menu/Menu";
import { RowButton, SettingRow } from "@/shared/ui/SettingRow/SettingRow";
import { StateSwap } from "@/shared/ui/StateSwap/StateSwap";

import type { HueActionId, HueActionSpec, HueNote, HueTone } from "./hueStateView";
import styles from "./HuePage.module.css";

type ResolvedAction = HueActionSpec & { id: HueActionId | string };

interface HueBridgeRowProps {
  /** The address, beside "Bridge". */
  address: string;
  word: string;
  tone: HueTone;
  note: HueNote | null;
  primary: ResolvedAction | null;
  secondary: readonly ResolvedAction[];
  more: readonly ResolvedAction[];
  /** Names the "…" button. */
  moreLabel: string;
  /** A result that belongs to the bridge, under its note. */
  children?: ReactNode;
}

/** The bridge: where it is, the state it is in, and the one thing to do about it. */
export function HueBridgeRow({
  address,
  word,
  tone,
  note,
  primary,
  secondary,
  more,
  moreLabel,
  children,
}: HueBridgeRowProps) {
  const { t } = useTranslation();
  return (
    <SettingRow
      label={t("hue:row.bridge")}
      value={address}
      testId="hue-bridge-row"
      control={
        <>
          <HueStateWord tone={tone}>{word}</HueStateWord>
          {secondary.map((action) => (
            <HueActionButton key={action.id} action={action} />
          ))}
          {primary ? <HueActionButton action={primary} primary /> : null}
          <Menu
            label={moreLabel}
            testId="hue-more"
            items={more.map((action) => ({
              id: action.id,
              label: action.label,
              onSelect: action.onClick,
              danger: action.danger,
              disabled: action.disabled || action.busy,
            }))}
          />
        </>
      }
    >
      {note ? <HueNoteLine note={note} /> : null}
      {children}
    </SettingRow>
  );
}

/** The state in a word, with a dot that says the same in colour. Read out when it changes. */
export function HueStateWord({ tone, children }: { tone: HueTone; children: ReactNode }) {
  return (
    <span className={styles.state} role="status" aria-live="polite" data-tone={tone} data-testid="hue-state">
      <span className={cx(styles.dot, styles[tone])} aria-hidden="true" />
      {children}
    </span>
  );
}

/** A row action. With a busy label it keeps the wider label's width, so nothing beside it moves. */
export function HueActionButton({ action, primary = false }: { action: ResolvedAction; primary?: boolean }) {
  const busy = action.busy ?? false;
  return (
    <RowButton
      primary={primary}
      onClick={action.onClick}
      disabled={action.disabled || busy}
      aria-busy={busy || undefined}
      data-action={action.id}
    >
      {action.busyLabel ? (
        <StateSwap fit state={busy ? "busy" : "idle"} faces={{ idle: action.label, busy: action.busyLabel }} />
      ) : (
        action.label
      )}
    </RowButton>
  );
}

/** What happened and what to do, in a line; the raw code, for support, behind ⓘ. */
export function HueNoteLine({ note, error = false }: { note: HueNote; error?: boolean }) {
  const { t } = useTranslation();
  return (
    <p
      className={cx(styles.note, error && styles.noteError)}
      role={error ? "alert" : "status"}
      aria-live={error ? undefined : "polite"}
      data-testid={note.testId}
    >
      {note.lines.join(" ")}
      {note.code ? (
        <>
          {" "}
          <InfoTip label={t("hue:page.codeTip")}>
            <span data-testid="hue-fault-code">
              {t("hue:card.codeLabel")} <code>{note.code}</code>
            </span>
          </InfoTip>
        </>
      ) : null}
    </p>
  );
}
