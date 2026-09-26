import type { UsbStripPlacement } from "@/shared/contracts/roomMap";

/**
 * The roster strip LED Setup's saved layout describes: the one on the
 * connected port, else the only strip there is. `null` when that is ambiguous.
 */
export function stripForCalibration(
  strips: readonly UsbStripPlacement[],
  connectedPort: string | null,
): UsbStripPlacement | null {
  if (connectedPort) {
    const onPort = strips.find((strip) => strip.portName === connectedPort);
    if (onPort) return onPort;
  }
  return strips.length === 1 ? (strips[0] ?? null) : null;
}

