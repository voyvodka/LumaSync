import { useTranslation } from "react-i18next";

import { HUE_SOLID_COLOR_STATUS, type HueRuntimeTarget, type HueSolidColorStatusCode } from "@/shared/contracts/hue";

export interface ShellNoticesProps {
  usbDisconnected: boolean;
  usbUnsupported: boolean;
  stopFailedTargets: HueRuntimeTarget[] | null;
  hueColorNotice: HueSolidColorStatusCode | null;
}

/**
 * The shell's transient toast stack. Purely presentational — every notice is
 * owned and auto-dismissed by the hook that raises it.
 */
export function ShellNotices({
  usbDisconnected,
  usbUnsupported,
  stopFailedTargets,
  hueColorNotice,
}: ShellNoticesProps) {
  const { t } = useTranslation();
  const stopFailed = stopFailedTargets !== null && stopFailedTargets.length > 0;

  return (
    <>
      {usbDisconnected && (
        <div
          data-testid="usb-disconnect-notice"
          className="fixed bottom-4 right-4 z-50 rounded-lg px-4 py-3 shadow-lg"
          role="status"
          aria-live="polite"
          style={{ background: "var(--lm-panel-2)", border: "1px solid var(--lm-line-2)", color: "var(--lm-ink)" }}
        >
          <span style={{ fontSize: "12px", color: "var(--lm-ink-dim)" }}>{t("common:hotplug.usbDisconnected")}</span>
        </div>
      )}
      {usbUnsupported && (
        <div
          className="fixed bottom-4 right-4 z-50 rounded-lg px-4 py-3 shadow-lg flex items-center gap-2"
          role="status"
          aria-live="polite"
          style={{
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
          className="fixed bottom-4 right-4 z-50 rounded-lg px-4 py-3 shadow-lg flex items-center gap-2"
          role="status"
          aria-live="polite"
          style={{
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
      {hueColorNotice && (
        <div
          className="fixed bottom-4 right-4 z-50 rounded-lg px-4 py-3 shadow-lg flex items-center gap-2"
          role="status"
          aria-live="polite"
          style={{
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
