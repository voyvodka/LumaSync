import { useTranslation } from "react-i18next";

import type { TranslationKey } from "@/features/i18n/catalogue";
import { CAPTURE_FAILURE_BUCKET, type CaptureFailureNotice } from "@/shared/contracts/capture";
import { HUE_SOLID_COLOR_STATUS, type HueRuntimeTarget, type HueSolidColorStatusCode } from "@/shared/contracts/hue";
import { HUE_LEFT_OUT_REASON, type HueLeftOutReason } from "@/shared/contracts/lighting";

export interface ShellNoticesProps {
  usbDisconnected: boolean;
  usbUnsupported: boolean;
  stopFailedTargets: HueRuntimeTarget[] | null;
  startFailure: CaptureFailureNotice | null;
  /** A `[usb, hue]` start ran on USB alone this session. */
  hueLeftOut: HueLeftOutReason | null;
  /** Capture died *after* a successful start — a live condition, not an event. */
  captureStalled: CaptureFailureNotice | null;
  hueColorNotice: HueSolidColorStatusCode | null;
  /** Deep-links the OS permission pane; only the `permission` bucket offers it. */
  onOpenCaptureSettings: () => void;
  /** Height of the StatusBar the stack must clear, so a toast never covers its hints. */
  statusBarHeightPx?: number;
}

const TOAST_GAP_PX = 8;

const HUE_LEFT_OUT_COPY: Record<HueLeftOutReason, TranslationKey> = {
  [HUE_LEFT_OUT_REASON.UNREACHABLE]: "common:hueLeftOut.unreachable",
  [HUE_LEFT_OUT_REASON.AUTH]: "common:hueLeftOut.auth",
  [HUE_LEFT_OUT_REASON.CONFIG]: "common:hueLeftOut.config",
};

/**
 * The shell's transient toast stack. Purely presentational — every notice is
 * owned and auto-dismissed by the hook that raises it.
 */
export function ShellNotices({
  usbDisconnected,
  usbUnsupported,
  stopFailedTargets,
  startFailure,
  hueLeftOut,
  captureStalled,
  hueColorNotice,
  onOpenCaptureSettings,
  statusBarHeightPx = 0,
}: ShellNoticesProps) {
  const { t } = useTranslation();
  const stopFailed = stopFailedTargets !== null && stopFailedTargets.length > 0;
  // A start failure means no worker exists, so the two can never co-fire; the
  // start toast wins to keep that invariant obvious if one ever does.
  const stalled = startFailure === null ? captureStalled : null;
  const bottom = `${statusBarHeightPx + TOAST_GAP_PX}px`;
  const hueLeftOutSlots =
    (usbDisconnected || stopFailed ? 1 : 0) + (startFailure !== null || stalled !== null ? 1 : 0);

  return (
    <>
      {usbDisconnected && (
        <div
          data-testid="usb-disconnect-notice"
          className="fixed right-4 z-50 rounded-lg px-4 py-3 shadow-lg"
          role="status"
          aria-live="polite"
          style={{ bottom, background: "var(--lm-panel-2)", border: "1px solid var(--lm-line-2)", color: "var(--lm-ink)" }}
        >
          <span style={{ fontSize: "12px", color: "var(--lm-ink-dim)" }}>{t("common:hotplug.usbDisconnected")}</span>
        </div>
      )}
      {usbUnsupported && (
        <div
          className="fixed right-4 z-50 rounded-lg px-4 py-3 shadow-lg flex items-center gap-2"
          role="status"
          aria-live="polite"
          style={{
            bottom,
            background: "var(--lm-panel-2)",
            border: "1px solid var(--lm-line-2)",
            color: "var(--lm-ink)",
            // Stack above usbDisconnectNotice / stopFailedNotice if any
            // ever co-fire — boot-time signal should sit highest.
            transform: usbDisconnected || stopFailed ? "translateY(-3.5rem)" : undefined,
          }}
        >
          <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--lm-amber)" }} />
          <span style={{ fontSize: "12px", color: "var(--lm-ink-dim)" }}>
            {t("common:hotplug.unsupportedFallback")}
          </span>
        </div>
      )}
      {stopFailed && stopFailedTargets && (
        <div
          className="fixed right-4 z-50 rounded-lg px-4 py-3 shadow-lg flex items-center gap-2"
          role="status"
          aria-live="polite"
          style={{
            bottom,
            background: "var(--lm-panel-2)",
            border: "1px solid var(--lm-red, #f87171)",
            color: "var(--lm-ink)",
            // Stack above usbDisconnectNotice if both ever co-fire (rare; sequential).
            transform: usbDisconnected ? "translateY(-3.5rem)" : undefined,
          }}
        >
          <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--lm-red, #f87171)" }} />
          <span style={{ fontSize: "12px", color: "var(--lm-ink-dim)" }}>
            {t("common:hotplug.stopFailed", {
              targets: stopFailedTargets
                .map((target) => t(`common:hotplug.targetLabel.${target}` as const))
                .join(", "),
            })}
          </span>
        </div>
      )}
      {startFailure && (
        <div
          data-testid="capture-start-failed-notice"
          className="fixed right-4 z-50 rounded-lg px-4 py-3 shadow-lg flex items-center gap-2"
          role="status"
          aria-live="polite"
          style={{
            bottom,
            background: "var(--lm-panel-2)",
            border: "1px solid var(--lm-red, #f87171)",
            color: "var(--lm-ink)",
            transform: usbDisconnected || stopFailed ? "translateY(-3.5rem)" : undefined,
          }}
        >
          <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--lm-red, #f87171)" }} />
          <span style={{ fontSize: "12px", color: "var(--lm-ink-dim)" }}>
            {startFailure.bucket === CAPTURE_FAILURE_BUCKET.INTERNAL && !startFailure.reason
              ? t("common:captureFailed.internalNoReason")
              : t(`common:captureFailed.${startFailure.bucket}` as const, { reason: startFailure.reason })}
          </span>
          {startFailure.bucket === CAPTURE_FAILURE_BUCKET.PERMISSION && (
            <button
              type="button"
              data-testid="capture-permission-settings-button"
              onClick={onOpenCaptureSettings}
              className="rounded px-2 py-1"
              style={{
                fontSize: "12px",
                color: "var(--lm-amber)",
                border: "1px solid var(--lm-line-2)",
                background: "transparent",
              }}
            >
              {t("common:captureAction.openSettings")}
            </button>
          )}
        </div>
      )}
      {stalled && (
        <div
          data-testid="capture-stalled-notice"
          className="fixed right-4 z-50 rounded-lg px-4 py-3 shadow-lg flex items-center gap-2"
          role="status"
          aria-live="polite"
          style={{
            bottom,
            background: "var(--lm-panel-2)",
            border: "1px solid var(--lm-red, #f87171)",
            color: "var(--lm-ink)",
            transform: usbDisconnected || stopFailed ? "translateY(-3.5rem)" : undefined,
          }}
        >
          <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--lm-red, #f87171)" }} />
          <span style={{ fontSize: "12px", color: "var(--lm-ink-dim)" }}>
            {stalled.bucket === CAPTURE_FAILURE_BUCKET.DISPLAY
              ? t("common:captureStalled.display")
              : stalled.reason
                ? t("common:captureStalled.generic", { reason: stalled.reason })
                : t("common:captureStalled.genericNoReason")}
          </span>
        </div>
      )}
      {hueLeftOut && (
        <div
          data-testid="hue-left-out-notice"
          // Full width in compact, where this copy runs two lines at 320 px.
          className="fixed left-4 right-4 z-50 rounded-lg px-4 py-3 shadow-lg flex items-center gap-2 sm:left-auto sm:max-w-sm"
          role="status"
          aria-live="polite"
          style={{
            bottom,
            background: "var(--lm-panel-2)",
            border: "1px solid var(--lm-amber)",
            color: "var(--lm-ink)",
            // Topmost: it can co-fire with a start or stop notice from the same apply.
            transform: hueLeftOutSlots > 0 ? `translateY(-${hueLeftOutSlots * 3.5}rem)` : undefined,
          }}
        >
          <span
            aria-hidden="true"
            className="shrink-0"
            style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--lm-amber)" }}
          />
          <span style={{ fontSize: "12px", color: "var(--lm-ink-dim)" }}>{t(HUE_LEFT_OUT_COPY[hueLeftOut])}</span>
        </div>
      )}
      {hueColorNotice && (
        <div
          className="fixed right-4 z-50 rounded-lg px-4 py-3 shadow-lg flex items-center gap-2"
          role="status"
          aria-live="polite"
          style={{
            bottom,
            background: "var(--lm-panel-2)",
            border: "1px solid var(--lm-amber)",
            color: "var(--lm-ink)",
            transform: usbDisconnected || stopFailed ? "translateY(-3.5rem)" : undefined,
          }}
        >
          <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--lm-amber)" }} />
          <span style={{ fontSize: "12px", color: "var(--lm-ink-dim)" }}>
            {hueColorNotice === HUE_SOLID_COLOR_STATUS.APPLY_SKIPPED_NO_LIGHTS
              ? t("hue:colorNotApplied.noLights")
              : t("hue:colorNotApplied.streamOffline")}
          </span>
        </div>
      )}
    </>
  );
}
