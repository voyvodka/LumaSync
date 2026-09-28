import { useTranslation } from "react-i18next";

import { InfoTip } from "@/shared/ui/InfoTip/InfoTip";
import { RowNote } from "@/shared/ui/SettingRow/SettingRow";

import { buildDeviceStatusCard } from "../deviceStatusCard";
import { wledStatusKey } from "../model/wledStatus";
import type { UseDeviceConnectionResult } from "../useDeviceConnection";
import styles from "./StripPage.module.css";

/** Whether the last connect of `port` failed: the controller's card is about the port it selected. */
export function connectFailedOn(device: UseDeviceConnectionResult, port: string): boolean {
  return device.statusCard?.variant === "error" && device.selectedPort === port && !device.isConnecting;
}

interface CodedFailure {
  code: string;
  message: string;
  details?: string | null;
}

/**
 * Why a strip is not lighting, in one short line, with what to do, Rust's own detail (an OS error,
 * kept verbatim) and the code behind one ⓘ: the state word says where it stands, this says why.
 */
export function CodedNote({ failure, testId }: { failure: CodedFailure; testId?: string }) {
  const { t } = useTranslation();
  const card = buildDeviceStatusCard({
    status: "error",
    statusCard: { variant: "error", code: failure.code, message: failure.message, details: failure.details ?? undefined },
    connectedPort: null,
  });
  return (
    <RowNote tone="error" testId={testId}>
      {t(card.titleKey)}{" "}
      <InfoTip label={t("device:strip.codeTip")}>
        {t(card.bodyKey)}
        {card.detailsKey ? ` ${t(card.detailsKey)}` : null}
        {card.details ? <span className={styles.detail}> {card.details}</span> : null}{" "}
        <span className={styles.code} data-testid="strip-fault-code">
          {t("device:strip.codeLabel")} <code>{failure.code}</code>
        </span>
      </InfoTip>
    </RowNote>
  );
}

/** A WLED answer that stopped something: its words, and the code behind one ⓘ. */
export function WledCodedNote({ status, prefix, testId }: { status: CodedFailure; prefix?: string; testId?: string }) {
  const { t } = useTranslation();
  const key = wledStatusKey(status.code);
  return (
    <RowNote tone="error" testId={testId}>
      {prefix ? `${prefix} ` : null}
      {key ? t(key) : status.message}{" "}
      <InfoTip label={t("device:strip.codeTip")}>
        {status.details ? <span className={styles.detail}>{status.details} </span> : null}
        <span className={styles.code} data-testid="strip-fault-code">
          {t("device:strip.codeLabel")} <code>{status.code}</code>
        </span>
      </InfoTip>
    </RowNote>
  );
}

/** What to check when a strip did not light, most likely first. */
export function UnlitHelp() {
  const { t } = useTranslation();
  return (
    <div className={styles.help} data-testid="strip-unlit-help">
      <p>{t("device:strip.flash.help.title")}</p>
      <ol>
        <li>{t("device:strip.flash.help.ground")}</li>
        <li>{t("device:strip.flash.help.data")}</li>
        <li>{t("device:strip.flash.help.firmware")}</li>
      </ol>
    </div>
  );
}
