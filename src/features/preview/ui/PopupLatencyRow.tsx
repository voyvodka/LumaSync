import { useTranslation } from "react-i18next";

import type { LatencyResult } from "@/shared/contracts/preview";
import { InfoTip } from "@/shared/ui/InfoTip/InfoTip";

import styles from "./PopupLatencyRow.module.css";

/** The latency scene's answer: the median pipeline delay, said under that name. */
export function PopupLatencyRow({ result }: { result: LatencyResult | null }) {
  const { t } = useTranslation();
  const measured = result !== null && result.samplesMs.length > 0;
  const unseen = result !== null && !measured && result.dropped > 0;
  return (
    <div className={styles.row} data-testid="popup-latency">
      <span className={styles.label}>{t("preview:latency.label")}</span>
      <InfoTip label={t("preview:latency.about")}>{t("preview:latency.info")}</InfoTip>
      <span className={styles.value} role="status">
        {measured
          ? t("preview:latency.value", { ms: Math.round(result.medianMs) })
          : unseen
            ? t("preview:latency.unseen")
            : t("preview:latency.measuring")}
      </span>
    </div>
  );
}
