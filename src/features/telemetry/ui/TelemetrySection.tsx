import { useTranslation } from "react-i18next";

import {
  hasSerialLinkBudget,
  type RuntimeTelemetrySnapshot,
} from "@/shared/contracts/telemetry";
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

interface LinkMaxTileProps {
  usb: RuntimeTelemetrySnapshot;
}

/** Absent — Hue-only, WLED-only, pre-worker — renders "—", never "0 fps": the
 *  sentinel carries no measurement. */
function LinkMaxTile({ usb }: LinkMaxTileProps) {
  const { t } = useTranslation();
  const present = hasSerialLinkBudget(usb);

  return (
    <article className="lm-tele-tile">
      <span className="k">{t("telemetry:metrics.linkMaxFps")}</span>
      {present ? (
        <span className={`v ${usb.linkConstrained ? "is-warn" : ""}`}>
          {t("telemetry:link.fpsFormat", { fps: usb.linkMaxFps.toFixed(2) })}
        </span>
      ) : (
        <span className="v" title={t("telemetry:link.absentTitle")} aria-label={t("telemetry:link.absentTitle")}>
          {t("telemetry:link.absent")}
        </span>
      )}
    </article>
  );
}

interface TelemetrySectionProps {
  localOutputConnected: boolean;
  /** The app owns a Hue session. A Hue-only setup has numbers too — the status bar showed its FPS while this stayed empty. */
  hueActive?: boolean;
}

/**
 * The readout under the "Show stats for nerds" row — the caller owns the
 * section element and the group header, and mounts this only while the
 * setting is on, so its poll does not exist otherwise.
 */
export function TelemetrySection({ localOutputConnected, hueActive = false }: TelemetrySectionProps) {
  const { t } = useTranslation();
  const polling = localOutputConnected || hueActive;
  const { snapshot, error, isLoading } = useFullTelemetryPoll(polling, POLL_INTERVAL_MS);
  // Only an error once a tick failed AND no snapshot ever landed: a transient
  // failure must not yank live values off screen for one poll interval.
  const hasError = error !== null && snapshot === null;

  const showEmpty =
    !polling
    || (!isLoading
      && !hasError
      && snapshot !== null
      && snapshot.usb.captureFps === 0
      && snapshot.usb.sendFps === 0
      && snapshot.hue === null);

  return (
    <>
      <div className="lm-tele-body" data-testid="telemetry-readout">
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
            {/* Send and queue describe the local strip's path; with none bound
                they carry no measurement, so they read "—", never 0. */}
            <article className="lm-tele-tile">
              <span className="k">{t("telemetry:metrics.sendFps")}</span>
              {localOutputConnected ? (
                <span className="v">{formatFps(snapshot.usb.sendFps)}</span>
              ) : (
                <span className="v" title={t("telemetry:local.absentTitle")} aria-label={t("telemetry:local.absentTitle")}>
                  {t("telemetry:link.absent")}
                </span>
              )}
            </article>
            <article className="lm-tele-tile">
              <span className="k">{t("telemetry:metrics.queueHealth")}</span>
              {localOutputConnected ? (
                <span className={`v ${queueHealthTint(snapshot.usb.queueHealth)}`}>
                  {t(`telemetry:queueHealth.${snapshot.usb.queueHealth}`)}
                </span>
              ) : (
                <span className="v" title={t("telemetry:local.absentTitle")} aria-label={t("telemetry:local.absentTitle")}>
                  {t("telemetry:link.absent")}
                </span>
              )}
            </article>
            <LinkMaxTile usb={snapshot.usb} />
          </div>
        ) : null}

        {!isLoading && !hasError && snapshot?.hue ? <HueTelemetryGrid hue={snapshot.hue} /> : null}

        {showEmpty ? <p className="lm-tele-note">{t("telemetry:states.empty")}</p> : null}
      </div>
    </>
  );
}
