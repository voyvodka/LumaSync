import { useTranslation } from "react-i18next";

import { useFullTelemetryPoll } from "../hooks/useFullTelemetryPoll";
import { HueTelemetryGrid } from "./HueTelemetryGrid";

const POLL_INTERVAL_MS = 2000;

function formatFps(value: number): string {
  return value.toFixed(2);
}

/** Rev 07 status tint for a queue-health bucket. */
function queueHealthTint(health: string): string {
  if (health === "healthy") return "is-ok";
  if (health === "warning") return "is-warn";
  if (health === "critical") return "is-crit";
  return "";
}

interface TelemetrySectionProps {
  usbConnected: boolean;
}

/**
 * Renders the CONTENTS of a `lm-settings-group` — the caller owns the section
 * element, so this matches the Language / Updates / About cards around it.
 */
export function TelemetrySection({ usbConnected }: TelemetrySectionProps) {
  const { t } = useTranslation("common");
  const { snapshot, error, isLoading } = useFullTelemetryPoll(usbConnected, POLL_INTERVAL_MS);
  // Only an error once a tick failed AND no snapshot ever landed: a transient
  // failure must not yank live values off screen for one poll interval.
  const hasError = error !== null && snapshot === null;

  const showEmpty =
    !isLoading
    && !hasError
    && snapshot !== null
    && snapshot.usb.captureFps === 0
    && snapshot.usb.sendFps === 0
    && snapshot.hue === null;

  return (
    <>
      <div className="lm-settings-group-h">
        <span className="t">{t("telemetry:title")}</span>
        <span className="sub">{t("settingsPage.groups.telemetry.sub")}</span>
      </div>

      <div className="lm-tele-body">
        <p className="lm-tele-desc">{t("telemetry:description")}</p>

        {isLoading ? <p className="lm-tele-note">{t("telemetry:states.loading")}</p> : null}

        {!isLoading && hasError ? (
          <p className="lm-tele-note is-error" role="alert">
            {t("telemetry:states.error")}
          </p>
        ) : null}

        {!isLoading && !hasError && snapshot ? (
          <div className="lm-tele-grid">
            <article className="lm-tele-tile">
              <span className="k">{t("telemetry:metrics.captureFps")}</span>
              <span className="v">{formatFps(snapshot.usb.captureFps)}</span>
            </article>
            <article className="lm-tele-tile">
              <span className="k">{t("telemetry:metrics.sendFps")}</span>
              <span className="v">{formatFps(snapshot.usb.sendFps)}</span>
            </article>
            <article className="lm-tele-tile">
              <span className="k">{t("telemetry:metrics.queueHealth")}</span>
              <span className={`v ${queueHealthTint(snapshot.usb.queueHealth)}`}>
                {t(`telemetry:queueHealth.${snapshot.usb.queueHealth}`)}
              </span>
            </article>
          </div>
        ) : null}

        {!isLoading && !hasError && snapshot?.hue ? <HueTelemetryGrid hue={snapshot.hue} /> : null}

        {showEmpty ? <p className="lm-tele-note">{t("telemetry:states.empty")}</p> : null}
      </div>
    </>
  );
}
