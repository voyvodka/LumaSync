import type { LedCalibrationConfig } from "@/features/calibration/model/contracts";
import { shellStore } from "@/features/persistence/shellStore";
import { DEFAULT_ROOM_MAP, type RoomMapConfig, type UsbStripPlacement } from "@/shared/contracts/roomMap";

/** LED count for a strip added before LED Setup has run. */
export const FALLBACK_STRIP_LED_COUNT = 60;
const MAX_STRIP_LED_COUNT = 1000;

/** The saved layout's total when there is one: it is the strip the user described. */
export function stripLedCount(calibration: LedCalibrationConfig | undefined): number {
  const total = calibration?.totalLeds;
  if (typeof total !== "number" || !Number.isFinite(total) || total < 1) return FALLBACK_STRIP_LED_COUNT;
  return Math.min(MAX_STRIP_LED_COUNT, Math.round(total));
}

/**
 * The room map with a roster entry for `portName`, or the same map when one
 * already covers it. A placement authored before strips carried a port is
 * adopted rather than duplicated, so a map the user drew keeps its one strip.
 */
export function withStripForPort(
  roomMap: RoomMapConfig,
  portName: string,
  ledCount: number,
  newStripId: () => string,
): { roomMap: RoomMapConfig; changed: boolean } {
  const strips = roomMap.usbStrips;
  if (strips.some((strip) => strip.portName === portName)) return { roomMap, changed: false };

  const unlinked = strips.find((strip) => !strip.portName);
  if (unlinked) {
    return {
      roomMap: {
        ...roomMap,
        usbStrips: strips.map((strip) => (strip === unlinked ? { ...strip, portName } : strip)),
      },
      changed: true,
    };
  }

  const widthMeters = roomMap.dimensions?.widthMeters ?? DEFAULT_ROOM_MAP.dimensions.widthMeters;
  const strip: UsbStripPlacement = {
    stripId: newStripId(),
    startX: 1,
    startY: 1,
    endX: Math.max(2, widthMeters - 1),
    endY: 1,
    ledCount,
    portName,
  };
  return { roomMap: { ...roomMap, usbStrips: [...strips, strip] }, changed: true };
}

/**
 * Makes sure the strip on `portName` is in the roster after a user-initiated
 * connect, writing only when something changes. Resolves with the roster as
 * stored. Output never reads `roomMap.usbStrips` — see
 * docs/architecture/ui-and-shell.md, "Devices → USB has one add path".
 */
export async function ensureStripForPort(portName: string): Promise<UsbStripPlacement[]> {
  const current = await shellStore.load();
  const roomMap = current.roomMap ?? DEFAULT_ROOM_MAP;
  const next = withStripForPort(
    roomMap,
    portName,
    stripLedCount(current.ledCalibration),
    () => `usb-${crypto.randomUUID()}`,
  );
  if (!next.changed) return roomMap.usbStrips;
  await shellStore.save({
    roomMap: next.roomMap,
    roomMapVersion: (current.roomMapVersion ?? 0) + 1,
  });
  return next.roomMap.usbStrips;
}
