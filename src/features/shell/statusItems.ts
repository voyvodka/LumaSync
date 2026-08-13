import type { TFunction } from "i18next";

import type { StatusItem } from "./StatusBar";

export interface StatusItemsInput {
  /** CAP is "ok" only while ambilight runs — it is the only frame-consuming mode. */
  ambilightActive: boolean;
  usbConnected: boolean;
  hueStreaming: boolean;
  hueReachable: boolean;
  hueConfigured: boolean;
  /** Deep-link offered by any chip that is not in a healthy state. */
  onOpenDevices: () => void;
}

/** Status items for the bottom StatusBar, in mockup order (CAP / USB / HUE).
 *  Every chip pairs colour with a text state — never colour alone. */
export function buildStatusItems(input: StatusItemsInput, t: TFunction): StatusItem[] {
  const { ambilightActive, usbConnected, hueStreaming, hueReachable, hueConfigured, onOpenDevices } =
    input;

  return [
    {
      label: "CAP",
      state: ambilightActive ? "OK" : "—",
      kind: ambilightActive ? "ok" : "idle",
    },
    {
      label: "USB",
      state: usbConnected ? "OK" : "OFF",
      kind: usbConnected ? "ok" : "off",
      onReconnect: usbConnected ? undefined : onOpenDevices,
      reconnectAriaLabel: t("shell:statusBar.reconnect.usbAriaLabel"),
    },
    {
      label: "HUE",
      state: hueStreaming
        ? "STREAMING"
        : hueReachable
          ? "OK"
          : hueConfigured
            ? "IDLE"
            : "OFF",
      kind: hueStreaming
        ? "active"
        : hueReachable
          ? "ok"
          : hueConfigured
            ? "idle"
            : "off",
      onReconnect: hueStreaming || hueReachable ? undefined : onOpenDevices,
      reconnectAriaLabel: t("shell:statusBar.reconnect.hueAriaLabel"),
    },
  ];
}
