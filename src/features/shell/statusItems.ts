import type { TFunction } from "i18next";

import type { LocalSink } from "@/features/device/localSink";
import type { DeviceCategory } from "@/features/device/model/deviceCategories";
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
  /**
   * A strip or WLED panel was ever set up — bound now, remembered, or bound
   * earlier this session. Without one an unbound local output is not an
   * outage: a Hue-only user read "USB OFF ↻" for good. Defaults to true.
   */
  localEverConfigured?: boolean;
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

/** Status items for the bottom StatusBar: capture (stats for nerds), the local output and Hue. Every
 *  chip pairs its colour with a word; one that is about something to deal with says what, in one
 *  sentence, and offers Devices. */
export function buildStatusItems(input: StatusItemsInput, t: TFunction): StatusItem[] {
  const {
    ambilightActive,
    localSink,
    localEverConfigured = true,
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
  const devices = t("settings:nav.sections.devices");

  // The chip names the transport that is bound, and USB when nothing is. It reconnects nothing
  // itself: what it offers is the page where that is done.
  const localHint = localEverConfigured ? t("shell:statusBar.hint.localOff") : t("shell:statusBar.hint.localNone");

  // Retrying and waiting already mean the app is on it: they offer nothing. A failed stream or a
  // left-out Hue offer Devices even with the bridge reachable: the bridge page is where either is dealt with.
  const hueHint = hueReconnecting || hueStreaming || hueWaiting
    ? null
    : hueLeftOut
      ? t("shell:statusBar.hint.hueLeftOut")
      : hueFailed
        ? t("shell:statusBar.hint.hueFailed")
        : hueReachable
          ? null
          : hueConfigured
            ? t("shell:statusBar.hint.hueUnreachable")
            : t("shell:statusBar.hint.hueNone");

  return [
    {
      id: "cap",
      label: t("shell:statusBar.capture"),
      state: ambilightActive ? t("shell:statusBar.state.ok") : "—",
      kind: ambilightActive ? "ok" : "idle",
      nerdStat: true,
    },
    {
      id: localSink?.transport === "wled" ? "wled" : "usb",
      label: localSink?.transport === "wled" ? "WLED" : "USB",
      state: localConnected
        ? t("shell:statusBar.state.ok")
        : localEverConfigured
          ? t("shell:statusBar.state.off")
          : "—",
      kind: localConnected ? "ok" : localEverConfigured ? "off" : "idle",
      attention: localConnected ? undefined : { hint: localHint, action: devices, onAction: () => onOpenDevices("strips") },
    },
    {
      id: "hue",
      label: "Hue",
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
                    : "—",
      // Amber, not green, while retrying or waiting; left out is amber too: the lights run on the
      // other outputs, and the notice beside it is a warning.
      kind: hueReconnecting || hueStreaming || hueWaiting || hueLeftOut
        ? "active"
        : hueFailed
          ? "error"
          : hueReachable
            ? "ok"
            : "idle",
      attention: hueHint === null ? undefined : { hint: hueHint, action: devices, onAction: () => onOpenDevices("hue") },
    },
  ];
}
