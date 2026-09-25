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

/**
 * The strip and LED total "LED counts from the map" works from. The total is
 * the saved LED Setup layout's — the strip's own count is stamped once, at
 * connect, and goes stale — falling back to the strip's count before any save.
 */
export function deriveSource(
  strips: readonly UsbStripPlacement[],
  connectedPort: string | null,
  savedTotalLeds: number | null | undefined,
): { strip: UsbStripPlacement; totalLeds: number } | null {
  const strip = stripForCalibration(strips, connectedPort) ?? strips[0] ?? null;
  if (!strip) return null;
  const totalLeds =
    typeof savedTotalLeds === "number" && Number.isFinite(savedTotalLeds) && savedTotalLeds > 0
      ? Math.round(savedTotalLeds)
      : strip.ledCount;
  return { strip, totalLeds };
}
