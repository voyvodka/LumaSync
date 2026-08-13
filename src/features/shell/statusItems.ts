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

// Derive runtime status items for the bottom StatusBar. Order matches the
// mockup (CAP / USB / HUE). CAP is "ok" only while ambilight is the active
// mode — that's the only mode that actually consumes screen frames.
// v1.5 W2-B1 — Reconnect deep-link to the DEVICES section. Both USB and
// Hue chips offer the affordance whenever they are not in a healthy state:
// the icon button rendered inside the StatusBar pill takes the user to
// the place they can actually fix the issue (re-pair, replug, retry).
// Every chip pairs its colour with a text state, never colour alone.
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
