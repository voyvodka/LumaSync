import type { TFunction } from "i18next";

import type { LocalSink } from "@/features/device/localSink";
import type { StatusItem } from "./StatusBar";

export interface StatusItemsInput {
  /** CAP is "ok" only while ambilight runs — it is the only frame-consuming mode. */
  ambilightActive: boolean;
  /** The bound local output, or null. Null is "nothing bound", not "no USB". */
  localSink: LocalSink | null;
  hueStreaming: boolean;
  /** The app owns a Hue session but the backend is retrying the bridge. Wins over `hueStreaming`. */
  hueReconnecting: boolean;
  hueReachable: boolean;
  hueConfigured: boolean;
  /** Deep-link offered by any chip that is not in a healthy state. */
  onOpenDevices: () => void;
}

/** Status items for the bottom StatusBar, in mockup order (CAP / USB / HUE).
 *  Every chip pairs colour with a text state — never colour alone. */
export function buildStatusItems(input: StatusItemsInput, t: TFunction): StatusItem[] {
  const {
    ambilightActive,
    localSink,
    hueStreaming,
    hueReconnecting,
    hueReachable,
    hueConfigured,
    onOpenDevices,
  } = input;
  const localConnected = localSink !== null;

  return [
    {
      label: "CAP",
      state: ambilightActive ? "OK" : "—",
      kind: ambilightActive ? "ok" : "idle",
    },
    {
      // The chip names the transport that is actually bound. "USB" is the
      // label when nothing is, because the reconnect deep-link lands on the
      // same screen either way and USB is the path a first-run user takes.
      label: localSink?.transport === "wled" ? "WLED" : "USB",
      state: localConnected ? "OK" : "OFF",
      kind: localConnected ? "ok" : "off",
      onReconnect: localConnected ? undefined : onOpenDevices,
      reconnectAriaLabel: t("shell:statusBar.reconnect.usbAriaLabel"),
    },
    {
      label: "HUE",
      // RETRYING rather than RECONNECTING: the compact bar has no room for a
      // value longer than STREAMING.
      state: hueReconnecting
        ? "RETRYING"
        : hueStreaming
          ? "STREAMING"
          : hueReachable
            ? "OK"
            : hueConfigured
              ? "IDLE"
              : "OFF",
      // Amber, not green, while retrying; no reconnect button, because the
      // backend is already doing exactly that.
      kind: hueReconnecting || hueStreaming
        ? "active"
        : hueReachable
          ? "ok"
          : hueConfigured
            ? "idle"
            : "off",
      onReconnect: hueReconnecting || hueStreaming || hueReachable ? undefined : onOpenDevices,
      reconnectAriaLabel: t("shell:statusBar.reconnect.hueAriaLabel"),
    },
  ];
}
