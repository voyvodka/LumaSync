import { useTranslation } from "react-i18next";

import { RowNote } from "@/shared/ui/SettingRow/SettingRow";

import { buildDeviceStatusCard } from "../deviceStatusCard";
import type { UseDeviceConnectionResult } from "../useDeviceConnection";
import styles from "./StripPage.module.css";

/** Whether the last connect of `port` failed: the controller's card is about the port it selected. */
export function connectFailedOn(device: UseDeviceConnectionResult, port: string): boolean {
  return device.statusCard?.variant === "error" && device.selectedPort === port && !device.isConnecting;
}

/** A failed connect, in the user's words, with Rust's own detail (an OS error) kept verbatim. */
export function ConnectErrorNote({ device }: { device: UseDeviceConnectionResult }) {
  const { t } = useTranslation();
  const card = buildDeviceStatusCard({ status: device.status, statusCard: device.statusCard, connectedPort: null });
  return (
    <RowNote tone="error" testId="strip-connect-error">
      {t(card.titleKey)}. {t(card.bodyKey)}
      {card.detailsKey ? ` ${t(card.detailsKey)}` : null}
      {card.details ? <span className={styles.detail}> {card.details}</span> : null}
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
