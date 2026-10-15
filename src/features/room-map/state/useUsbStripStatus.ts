import { useCallback } from "react";

import { connectedSerialPort } from "@/features/device/model/localOutputs";
import { useLocalOutputs } from "@/features/device/state/localOutputsStore";
import type { UsbStripPlacement } from "@/shared/contracts/roomMap";
import { shallowEqual } from "@/shared/lib/store";

import type { UsbStripConnectionStatus } from "../ui/objects/UsbStripInspector";

export interface UsbStripStatus {
  stripStatus: (strip: UsbStripPlacement) => { status: UsbStripConnectionStatus; port: string | null };
  hueBridgeStatus: UsbStripConnectionStatus;
}

/** How each strip and the bridge read right now, for either face of the room map. */
export function useUsbStripStatus(hueReachable: boolean | undefined): UsbStripStatus {
  // The registry every other screen reads, so a pair or an unplug anywhere reaches the room map.
  const usb = useLocalOutputs(
    ({ snapshot }) => ({ ready: snapshot !== null, connectedPort: connectedSerialPort(snapshot) }),
    shallowEqual,
  );

  // Graded per strip against the live port, so a controller moved to another port reads offline.
  // A legacy strip with no `portName` keeps the any-port-active reading.
  const stripStatus = useCallback(
    (strip: UsbStripPlacement): { status: UsbStripConnectionStatus; port: string | null } => {
      if (!usb.ready) return { status: "unknown", port: strip.portName ?? null };
      if (strip.portName) return { status: strip.portName === usb.connectedPort ? "connected" : "disconnected", port: strip.portName };
      return { status: usb.connectedPort ? "connected" : "disconnected", port: usb.connectedPort };
    },
    [usb.ready, usb.connectedPort],
  );
  // `undefined` means no source of truth (a legacy embed passes nothing) and
  // must show no state at all — it is not the same as `false`.
  const hueBridgeStatus: UsbStripConnectionStatus =
    hueReachable === undefined ? "unknown" : hueReachable ? "connected" : "disconnected";

  return { stripStatus, hueBridgeStatus };
}
