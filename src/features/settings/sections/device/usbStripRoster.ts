import type { LedCalibrationConfig } from "@/features/calibration/model/contracts";
import { shellStore } from "@/features/persistence/shellStore";
import { stripForCalibration } from "@/features/room-map/model/calibrationStrip";
import { DEFAULT_ROOM_MAP, type RoomMapConfig, type UsbStripPlacement } from "@/shared/contracts/roomMap";

/** LED count for a strip added before LED Setup has run. */
export const FALLBACK_STRIP_LED_COUNT = 60;
const MAX_STRIP_LED_COUNT = 1000;

/** The saved layout's total when there is one: it is the strip the user described. */
export function stripLedCount(calibration: LedCalibrationConfig | undefined): number {
  return ledCountFromTotal(calibration?.totalLeds);
}

function ledCountFromTotal(total: number | undefined): number {
  if (typeof total !== "number" || !Number.isFinite(total) || total < 1) return FALLBACK_STRIP_LED_COUNT;
  return Math.min(MAX_STRIP_LED_COUNT, Math.round(total));
}

/**
 * The room map with a roster entry for `portName`, or the same map when one
 * already covers it. A placement authored before strips carried a port is
 * adopted rather than duplicated, so a map the user drew keeps its one strip —
 * but only when that is unambiguous: it is the one unlinked placement, and no
 * other port was driving the strip until now. `previousPort` is that port (the
 * one connected, or last connected, before this connect); a second controller
 * on another port gets its own strip instead of relabelling the first one's.
 */
export function withStripForPort(
  roomMap: RoomMapConfig,
  portName: string,
  ledCount: number,
  newStripId: () => string,
  previousPort: string | null = null,
): { roomMap: RoomMapConfig; changed: boolean } {
  const strips = roomMap.usbStrips;
  if (strips.some((strip) => strip.portName === portName)) return { roomMap, changed: false };

  const unlinked = strips.filter((strip) => !strip.portName);
  const adoptable = unlinked.length === 1 && (previousPort === null || previousPort === portName);
  if (adoptable) {
    const [placement] = unlinked;
    return {
      roomMap: {
        ...roomMap,
        usbStrips: strips.map((strip) => (strip === placement ? { ...strip, portName } : strip)),
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
 *
 * Goes through `shellStore.update`, not load-then-save: a save replaces the
 * whole `roomMap` key, so channels or zones written between the read and the
 * save would be reverted.
 */
export async function ensureStripForPort(
  portName: string,
  previousPort: string | null = null,
): Promise<UsbStripPlacement[]> {
  const newStripId = `usb-${crypto.randomUUID()}`;
  let roster: UsbStripPlacement[] = [];
  await shellStore.update((current) => {
    const roomMap = current.roomMap ?? DEFAULT_ROOM_MAP;
    const next = withStripForPort(
      roomMap,
      portName,
      stripLedCount(current.ledCalibration),
      () => newStripId,
      previousPort,
    );
    roster = next.roomMap.usbStrips;
    if (!next.changed) return null;
    return { roomMap: next.roomMap, roomMapVersion: (current.roomMapVersion ?? 0) + 1 };
  });
  return roster;
}

/** The room map with that strip's LED count set to `totalLeds`, or the same map. */
export function withStripLedCount(
  roomMap: RoomMapConfig,
  totalLeds: number,
  connectedPort: string | null,
): { roomMap: RoomMapConfig; changed: boolean } {
  const target = stripForCalibration(roomMap.usbStrips, connectedPort);
  const ledCount = ledCountFromTotal(totalLeds);
  if (!target || target.ledCount === ledCount) return { roomMap, changed: false };
  return {
    roomMap: {
      ...roomMap,
      usbStrips: roomMap.usbStrips.map((strip) => (strip === target ? { ...strip, ledCount } : strip)),
    },
    changed: true,
  };
}

/**
 * Keeps the roster strip's LED count in step with a newly saved LED Setup
 * total. The count is stamped once at connect; without this the room map's
 * strip — and anything derived from it — kept the count from that day on.
 */
export async function syncStripLedCount(totalLeds: number, connectedPort: string | null): Promise<void> {
  await shellStore.update((current) => {
    if (!current.roomMap) return null;
    const next = withStripLedCount(current.roomMap, totalLeds, connectedPort);
    if (!next.changed) return null;
    return { roomMap: next.roomMap, roomMapVersion: (current.roomMapVersion ?? 0) + 1 };
  });
}
