import { useTranslation } from "react-i18next";

import type { HueTelemetrySnapshot } from "../model/contracts";

interface HueTelemetryGridProps {
  hue: HueTelemetrySnapshot;
}

function formatDuration(secs: number | null): string {
  if (secs === null || secs < 0) return "—";
  const minutes = Math.floor(secs / 60);
  const seconds = Math.round(secs % 60);
  return `${minutes}m ${seconds}s`;
}

/** Rev 07 status tint for a stream state. */
function stateTint(state: string): string {
  if (state === "Running") return "is-ok";
  if (state === "Reconnecting") return "is-warn";
  if (state === "Failed") return "is-crit";
  return "";
}

export function HueTelemetryGrid({ hue }: HueTelemetryGridProps) {
  const { t } = useTranslation("common");

  return (
    <>
      <div className="lm-tele-sub-title">{t("telemetry:hue.title")}</div>
      <div className="lm-tele-rows">
        <div className="lm-tele-row">
          <span className="k">{t("telemetry:hue.status")}</span>
          <span className={`v ${stateTint(hue.state)}`}>
            {hue.state}
            {hue.uptimeSecs !== null && hue.state === "Running" ? (
              <span className="age">{formatDuration(hue.uptimeSecs)}</span>
            ) : null}
          </span>
        </div>

        <div className="lm-tele-row">
          <span className="k">{t("telemetry:hue.packetRate")}</span>
          <span className="v">{hue.packetRate.toFixed(1)} pkt/s</span>
        </div>

        <div className="lm-tele-row">
          <span className="k">{t("telemetry:hue.lastError")}</span>
          <span className={`v ${hue.lastErrorCode ? "is-crit" : ""}`}>
            {hue.lastErrorCode
              ? `${hue.lastErrorCode}${hue.lastErrorAtSecs !== null ? ` — ${Math.floor(hue.lastErrorAtSecs / 60)}m ago` : ""}`
              : "—"}
          </span>
        </div>

        <div className="lm-tele-row">
          <span className="k">{t("telemetry:hue.reconnects")}</span>
          <span className="v">
            {hue.totalReconnects} ({hue.successfulReconnects} ok, {hue.failedReconnects} fail)
          </span>
        </div>

        <div className="lm-tele-row">
          <span className="k">{t("telemetry:hue.dtlsCipher")}</span>
          <span className="v">{hue.dtlsCipher ?? "—"}</span>
        </div>

        <div className="lm-tele-row">
          <span className="k">{t("telemetry:hue.connectionAge")}</span>
          <span className="v">{formatDuration(hue.dtlsConnectedAtSecs)}</span>
        </div>
      </div>
    </>
  );
}
