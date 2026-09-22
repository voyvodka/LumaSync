import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";

import type { HueTelemetrySnapshot } from "@/shared/contracts/telemetry";

interface HueTelemetryGridProps {
  hue: HueTelemetrySnapshot;
}

function formatDuration(t: TFunction, secs: number | null): string {
  if (secs === null || secs < 0) return "—";
  const minutes = Math.floor(secs / 60);
  const seconds = Math.round(secs % 60);
  return t("telemetry:hue.uptimeFormat", { minutes, seconds });
}

/** Rev 07 status tint for a stream state. */
function stateTint(state: string): string {
  if (state === "Running") return "is-ok";
  if (state === "Reconnecting") return "is-warn";
  if (state === "Failed") return "is-crit";
  return "";
}

export function HueTelemetryGrid({ hue }: HueTelemetryGridProps) {
  const { t } = useTranslation();

  return (
    <>
      <div className="lm-tele-sub-title">{t("telemetry:hue.title")}</div>
      <div className="lm-tele-rows">
        <div className="lm-tele-row">
          <span className="k">{t("telemetry:hue.status")}</span>
          <span className={`v ${stateTint(hue.state)}`}>
            {t(`hue:runtime.states.${hue.state}`, { defaultValue: hue.state })}
            {hue.uptimeSecs !== null && hue.state === "Running" ? (
              <span className="age">{formatDuration(t, hue.uptimeSecs)}</span>
            ) : null}
          </span>
        </div>

        <div className="lm-tele-row">
          <span className="k">{t("telemetry:hue.packetRate")}</span>
          <span className="v">
            {t("telemetry:hue.packetRateFormat", { rate: hue.packetRate.toFixed(1) })}
          </span>
        </div>

        <div className="lm-tele-row">
          <span className="k">{t("telemetry:hue.lastError")}</span>
          <span className={`v ${hue.lastErrorCode ? "is-crit" : ""}`}>
            {!hue.lastErrorCode
              ? t("telemetry:hue.noError")
              : hue.lastErrorAtSecs === null
                ? hue.lastErrorCode
                : t("telemetry:hue.errorAgo", {
                    code: hue.lastErrorCode,
                    minutes: Math.floor(hue.lastErrorAtSecs / 60),
                  })}
          </span>
        </div>

        <div className="lm-tele-row">
          <span className="k">{t("telemetry:hue.reconnects")}</span>
          <span className="v">
            {t("telemetry:hue.reconnectsFormat", {
              total: hue.totalReconnects,
              success: hue.successfulReconnects,
              failed: hue.failedReconnects,
            })}
          </span>
        </div>

        <div className="lm-tele-row">
          <span className="k">{t("telemetry:hue.dtlsCipher")}</span>
          <span className="v">{hue.dtlsCipher ?? "—"}</span>
        </div>

        <div className="lm-tele-row">
          <span className="k">{t("telemetry:hue.connectionAge")}</span>
          <span className="v">{formatDuration(t, hue.dtlsConnectedAtSecs)}</span>
        </div>
      </div>
    </>
  );
}
