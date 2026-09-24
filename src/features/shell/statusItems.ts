import type { TFunction } from "i18next";

import type { LocalSink } from "@/features/device/localSink";
import type { DeviceCategory } from "@/features/settings/sections/DeviceSection";
import type { BootHueRetryState } from "@/shared/contracts/lightingRuntime";
import { HUE_LEFT_OUT_REASON, type HueLeftOutReason } from "@/shared/contracts/lighting";
import type { StatusItem } from "./StatusBar";

/**
 * Hue is out of what the backend runs: a boot retry is still waiting for the
 * bridge to free its area, or a start left Hue out of a running mode.
 */
export type HueHeldOut = "waiting" | "leftOut";

export interface HueHeldOutInput {
  /** The orchestrator's latched reason, which outlives the left-out notice. */
  leftOutReason: HueLeftOutReason | null;
  bootHueRetry: BootHueRetryState | null;
  lightingRunning: boolean;
  hueSessionActive: boolean;
}

/** `null` whenever Hue is part of the running output, or nothing says otherwise. */
export function resolveHueHeldOut({
  leftOutReason,
  bootHueRetry,
  lightingRunning,
  hueSessionActive,
}: HueHeldOutInput): HueHeldOut | null {
  if (hueSessionActive) return null;
  // The resume wait runs with the mode Off, so it is not gated on a running mode.
  if (bootHueRetry === "waiting") return "waiting";
  if (!lightingRunning || leftOutReason === null) return null;
  return leftOutReason === HUE_LEFT_OUT_REASON.BUSY ? "waiting" : "leftOut";
}

export interface StatusItemsInput {
  /** CAP is "ok" only while ambilight runs — it is the only frame-consuming mode. */
  ambilightActive: boolean;
  /** The bound local output, or null. Null is "nothing bound", not "no USB". */
  localSink: LocalSink | null;
  hueStreaming: boolean;
  /** The app owns a Hue session but the backend is retrying the bridge. Wins over `hueStreaming`. */
  hueReconnecting: boolean;
  /** The backend reports the Hue stream Failed while Hue is a selected output. */
  hueFailed: boolean;
  /** From {@link resolveHueHeldOut}. Wins over the bridge's own health, which a busy bridge passes. */
  hueHeldOut?: HueHeldOut | null;
  hueReachable: boolean;
  hueConfigured: boolean;
  /** Deep-link offered by any chip that is not in a healthy state, to that chip's category. */
  onOpenDevices: (category: DeviceCategory) => void;
}

/** Status items for the bottom StatusBar, in mockup order (CAP / USB / HUE).
 *  Every chip pairs colour with a text state — never colour alone. */
export function buildStatusItems(input: StatusItemsInput, t: TFunction): StatusItem[] {
  const {
    ambilightActive,
    localSink,
    hueStreaming,
    hueReconnecting,
    hueFailed,
    hueHeldOut = null,
    hueReachable,
    hueConfigured,
    onOpenDevices,
  } = input;
  const localConnected = localSink !== null;
  const hueWaiting = hueHeldOut === "waiting";
  const hueLeftOut = hueHeldOut === "leftOut";

  return [
    {
      label: "CAP",
      state: ambilightActive ? t("shell:statusBar.state.ok") : "—",
      kind: ambilightActive ? "ok" : "idle",
      nerdStat: true,
    },
    {
      // The chip names the transport that is actually bound, and "USB" when
      // nothing is. Only then does it offer a reconnect (a WLED chip is a
      // bound, connected sink), so the deep link opens the USB category: the
      // label on screen, and the path a first-run user takes.
      label: localSink?.transport === "wled" ? "WLED" : "USB",
      state: localConnected ? t("shell:statusBar.state.ok") : t("shell:statusBar.state.off"),
      kind: localConnected ? "ok" : "off",
      onReconnect: localConnected ? undefined : () => onOpenDevices("usb"),
      reconnectAriaLabel: t("shell:statusBar.reconnect.usbAriaLabel"),
    },
    {
      label: "HUE",
      // RETRYING rather than RECONNECTING: the compact bar has no room for a
      // value longer than STREAMING.
      state: hueReconnecting
        ? t("shell:statusBar.state.retrying")
        : hueStreaming
          ? t("shell:statusBar.state.streaming")
          : hueWaiting
            ? t("shell:statusBar.state.waiting")
            : hueLeftOut
              ? t("shell:statusBar.state.leftOut")
              : hueFailed
                ? t("shell:statusBar.state.failed")
                : hueReachable
                  ? t("shell:statusBar.state.ok")
                  : hueConfigured
                    ? t("shell:statusBar.state.idle")
                    : t("shell:statusBar.state.off"),
      // Amber, not green, while retrying or waiting; no reconnect button, because
      // the app is already doing exactly that.
      kind: hueReconnecting || hueStreaming || hueWaiting
        ? "active"
        : hueFailed || hueLeftOut
          ? "error"
          : hueReachable
            ? "ok"
            : hueConfigured
              ? "idle"
              : "off",
      // A failed stream or a left-out Hue links to Devices even with the bridge
      // reachable: the bridge card is where either is dealt with.
      onReconnect:
        hueReconnecting || hueStreaming || hueWaiting || (hueReachable && !hueFailed && !hueLeftOut)
          ? undefined
          : () => onOpenDevices("hue"),
      reconnectAriaLabel: t("shell:statusBar.reconnect.hueAriaLabel"),
    },
  ];
}
