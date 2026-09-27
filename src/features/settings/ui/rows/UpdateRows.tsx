import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { setPreference, usePreference } from "@/features/persistence/preferences";
import { DevUpdaterMenu } from "./DevUpdaterMenu";
import { APP_VERSION } from "@/shared/constants/app";
import type { UpdateChannel } from "@/shared/contracts/shell";
import { IconCheck } from "@/shared/ui/icons";
import { Popover } from "@/shared/ui/Popover/Popover";
import { StateSwap } from "@/shared/ui/StateSwap/StateSwap";
import { Toggle } from "@/shared/ui/Toggle";
import { RowButton, SettingRow } from "@/shared/ui/SettingRow/SettingRow";
import type { SettingsEnv } from "../settingsEnv";
import styles from "./UpdateRows.module.css";

/** How long "Up to date" stays on the button after a check the user asked for. */
export const UP_TO_DATE_RESULT_MS = 12_000;

type CheckFace = "idle" | "checking" | "done";

/**
 * The result of a check lands in the button that asked for it — "Checking…", then "✓ Up to date"
 * for a while — rather than in a line under the row. A newer version opens the update dialog.
 */
export function UpdateCheckRow({ onCheckForUpdates, isCheckingForUpdates, upToDateAt = null, devSetUpdaterState }: SettingsEnv) {
  const { t, i18n } = useTranslation();

  // A result, not a state: it goes once read.
  const [expiredAt, setExpiredAt] = useState<number | null>(null);
  useEffect(() => {
    if (upToDateAt === null) return;
    const timerId = window.setTimeout(() => setExpiredAt(upToDateAt), UP_TO_DATE_RESULT_MS);
    return () => window.clearTimeout(timerId);
  }, [upToDateAt]);
  const shown = upToDateAt !== null && upToDateAt !== expiredAt && !isCheckingForUpdates;
  const time = shown ? new Intl.DateTimeFormat(i18n.language, { hour: "2-digit", minute: "2-digit" }).format(upToDateAt) : "";

  const face: CheckFace = isCheckingForUpdates ? "checking" : shown ? "done" : "idle";
  const faces: Record<CheckFace, ReactNode> = {
    idle: t("updater:checkAction"),
    checking: t("updater:checking"),
    done: (
      <>
        <span className={styles.ok} aria-hidden="true">
          <IconCheck />
        </span>
        {t("updater:upToDateShort")}
      </>
    ),
  };

  return (
    <SettingRow
      label={`v${APP_VERSION}`}
      control={
        <>
          {import.meta.env.DEV && devSetUpdaterState && <DevUpdaterMenu onSetState={devSetUpdaterState} />}
          <RowButton
            onClick={onCheckForUpdates}
            disabled={isCheckingForUpdates}
            aria-busy={isCheckingForUpdates}
            data-testid="update-check"
          >
            <StateSwap state={face} faces={faces} fit />
          </RowButton>
        </>
      }
    >
      {/* The full sentence, with the time, for a screen reader; the button shows the short one. */}
      <p className="sr-only" role="status" aria-live="polite" data-testid="update-check-result">
        {shown ? t("updater:upToDate", { time }) : ""}
      </p>
    </SettingRow>
  );
}

export function BetaChannelRow() {
  const { t } = useTranslation();
  // From the preferences read at boot, so the switch opens on the stored channel instead of the
  // build's default and then sliding over when a read of its own came back.
  const channel = usePreference("updateChannel");
  const [confirming, setConfirming] = useState(false);
  const switchRef = useRef<HTMLButtonElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (confirming) confirmRef.current?.focus();
  }, [confirming]);

  // Reverted on failure: Rust reads this same field off disk to pick the endpoint, so a toggle
  // the store rejected must not look on.
  function save(next: UpdateChannel) {
    void setPreference("updateChannel", next);
  }

  // Joining the beta asks once more, beside the switch; leaving it is the safe way and does not.
  // The switch stays off while it asks, so a second press is the same request: it closes the
  // question, as pressing a popover's own trigger does.
  function change(next: boolean) {
    if (next) {
      setConfirming((open) => !open);
      return;
    }
    setConfirming(false);
    save("stable");
  }

  function cancel() {
    setConfirming(false);
    switchRef.current?.focus();
  }

  const label = t("updater:betaChannel");
  return (
    <SettingRow
      label={label}
      hint={t("updater:betaChannelDescription")}
      control={
        <Toggle
          ref={switchRef}
          checked={channel === "beta"}
          onChange={change}
          label={label}
          aria-expanded={channel === "beta" ? undefined : confirming}
          data-testid="beta-channel-toggle"
        />
      }
    >
      {/* A popover from the switch rather than a panel under the row: it covers nothing it
          would push, so the rows below never move when it opens or goes. */}
      <Popover
        open={confirming}
        onClose={() => setConfirming(false)}
        anchorRef={switchRef}
        side="below"
        width={280}
        label={label}
        role="dialog"
      >
        <div className={styles.confirm} data-testid="beta-confirm">
          <p className={styles.confirmText}>{t("updater:betaConfirm.text")}</p>
          <div className={styles.confirmActions}>
            <RowButton onClick={cancel}>{t("updater:betaConfirm.cancel")}</RowButton>
            <RowButton
              ref={confirmRef}
              className={styles.primary}
              onClick={() => {
                setConfirming(false);
                save("beta");
                switchRef.current?.focus();
              }}
              data-testid="beta-confirm-yes"
            >
              {t("updater:betaConfirm.confirm")}
            </RowButton>
          </div>
        </div>
      </Popover>
    </SettingRow>
  );
}
