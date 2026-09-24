// Connecting a controller is the one way a strip joins the roster. It must add
// exactly one entry per port, and leave a map the user already drew alone.

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { LedCalibrationConfig } from "@/features/calibration/model/contracts";
import type { ShellState } from "@/shared/contracts/shell";
import { DEFAULT_ROOM_MAP, type RoomMapConfig, type UsbStripPlacement } from "@/shared/contracts/roomMap";

import {
  ensureStripForPort,
  FALLBACK_STRIP_LED_COUNT,
  stripLedCount,
  withStripForPort,
} from "../usbStripRoster";

const { stateRef, saveMock } = vi.hoisted(() => ({
  stateRef: { current: {} as Partial<ShellState> },
  saveMock: vi.fn<(partial: Partial<ShellState>) => void>(),
}));

vi.mock("@/features/persistence/shellStore", () => ({
  shellStore: {
    load: () => Promise.resolve(stateRef.current),
    save: (partial: Partial<ShellState>) => {
      saveMock(partial);
      stateRef.current = { ...stateRef.current, ...partial };
      return Promise.resolve();
    },
  },
}));

const PORT = "/dev/cu.usbserial-1420";

function strip(overrides: Partial<UsbStripPlacement> = {}): UsbStripPlacement {
  return { stripId: "usb-a", startX: 0.5, startY: 0.5, endX: 3, endY: 0.5, ledCount: 42, ...overrides };
}

function roomMap(usbStrips: UsbStripPlacement[]): RoomMapConfig {
  return { ...DEFAULT_ROOM_MAP, usbStrips };
}

const LAYOUT = { totalLeds: 118 } as LedCalibrationConfig;

describe("withStripForPort", () => {
  it("adds one strip for a port the roster has never seen", () => {
    const { roomMap: next, changed } = withStripForPort(roomMap([]), PORT, 90, () => "usb-new");
    expect(changed).toBe(true);
    expect(next.usbStrips).toEqual([
      expect.objectContaining({ stripId: "usb-new", portName: PORT, ledCount: 90 }),
    ]);
  });

  it("changes nothing when a strip already names the port", () => {
    const existing = roomMap([strip({ portName: PORT })]);
    const result = withStripForPort(existing, PORT, 90, () => "usb-new");
    expect(result.changed).toBe(false);
    expect(result.roomMap).toBe(existing);
  });

  // A map drawn before strips carried a port keeps its one strip, now linked,
  // with its geometry and LED count as the user left them.
  it("adopts an unlinked strip rather than adding a second one", () => {
    const drawn = strip();
    const { roomMap: next, changed } = withStripForPort(roomMap([drawn]), PORT, 90, () => "usb-new");
    expect(changed).toBe(true);
    expect(next.usbStrips).toEqual([{ ...drawn, portName: PORT }]);
  });

  it("adds a strip for a second controller beside one on another port", () => {
    const other = strip({ portName: "/dev/cu.usbserial-9" });
    const { roomMap: next } = withStripForPort(roomMap([other]), PORT, 90, () => "usb-new");
    expect(next.usbStrips.map((s) => s.portName)).toEqual(["/dev/cu.usbserial-9", PORT]);
  });
});

describe("stripLedCount", () => {
  it("uses the saved LED layout, and a fallback before there is one", () => {
    expect(stripLedCount(LAYOUT)).toBe(118);
    expect(stripLedCount(undefined)).toBe(FALLBACK_STRIP_LED_COUNT);
    expect(stripLedCount({ totalLeds: 0 } as LedCalibrationConfig)).toBe(FALLBACK_STRIP_LED_COUNT);
    expect(stripLedCount({ totalLeds: 5000 } as LedCalibrationConfig)).toBe(1000);
  });
});

describe("ensureStripForPort", () => {
  beforeEach(() => {
    stateRef.current = {};
    saveMock.mockClear();
  });

  it("writes one entry however often the same port connects", async () => {
    stateRef.current = { ledCalibration: LAYOUT, roomMapVersion: 3 };

    const first = await ensureStripForPort(PORT);
    const second = await ensureStripForPort(PORT);

    expect(saveMock).toHaveBeenCalledTimes(1);
    expect(saveMock.mock.calls[0][0].roomMapVersion).toBe(4);
    expect(first).toEqual([expect.objectContaining({ portName: PORT, ledCount: 118 })]);
    expect(second).toEqual(first);
  });

  it("never writes when a strip already covers the port", async () => {
    const drawn = strip({ portName: PORT });
    stateRef.current = { roomMap: roomMap([drawn]) };

    await expect(ensureStripForPort(PORT)).resolves.toEqual([drawn]);
    expect(saveMock).not.toHaveBeenCalled();
  });
});
