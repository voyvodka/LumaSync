import { describe, expect, it } from "vitest";

import { DEVICE_STATUS } from "@/shared/contracts/device";
import type { SerialConnectionStatus, SerialPortListResponse } from "../deviceConnectionApi";
import {
  DEFAULT_STATE,
  nextStatusForReadyState,
  toConnectionCard,
  toDevicePort,
  toSortKey,
  withDerivedFlags,
} from "../state/connectionStateHelpers";

function rawPort(overrides: Partial<SerialPortListResponse["ports"][number]> = {}): SerialPortListResponse["ports"][number] {
  return {
    name: "COM3",
    kind: "usb",
    isSupported: true,
    supportReason: "Supported USB serial adapter",
    usb: {
      vid: 0x1a86,
      pid: 0x7523,
      manufacturer: "WCH",
      product: "CH340",
      serialNumber: null,
    },
    ...overrides,
  };
}

describe("toSortKey", () => {
  it("prefers product/manufacturer over the raw port name", () => {
    expect(toSortKey(rawPort())).toBe("ch340-wch-com3");
  });

  it("falls back to the port name when USB metadata is absent", () => {
    expect(toSortKey(rawPort({ usb: null }))).toBe("com3");
  });
});

describe("toDevicePort", () => {
  it("passes isSupported, vid, and pid through unchanged", () => {
    const port = toDevicePort(rawPort({ isSupported: false }));

    expect(port.isSupported).toBe(false);
    expect(port.vid).toBe(0x1a86);
    expect(port.pid).toBe(0x7523);
    expect(port.portName).toBe("COM3");
  });

  it("maps null USB manufacturer/product to undefined, not null", () => {
    const port = toDevicePort(rawPort({ usb: { vid: 1, pid: 2, manufacturer: null, product: null, serialNumber: null } }));

    expect(port.manufacturer).toBeUndefined();
    expect(port.product).toBeUndefined();
  });
});

describe("nextStatusForReadyState", () => {
  it("is IDLE with zero ports and READY otherwise", () => {
    expect(nextStatusForReadyState([])).toBe(DEVICE_STATUS.IDLE);
    expect(nextStatusForReadyState([toDevicePort(rawPort())])).toBe(DEVICE_STATUS.READY);
  });
});

describe("toConnectionCard", () => {
  function status(connected: boolean): SerialConnectionStatus {
    return {
      portName: connected ? "COM3" : null,
      connected,
      updatedAtUnixMs: 0,
      status: { code: connected ? "CONNECT_OK" : "CONNECT_FAILED", message: "msg", details: "details" },
    };
  }

  it("maps a connected status to the success variant", () => {
    expect(toConnectionCard(status(true))).toMatchObject({ variant: "success", code: "CONNECT_OK" });
  });

  it("maps a disconnected status to the error variant", () => {
    expect(toConnectionCard(status(false))).toMatchObject({ variant: "error", code: "CONNECT_FAILED" });
  });
});

describe("withDerivedFlags", () => {
  it("can connect once a port is selected, not scanning, and not already connecting", () => {
    const state = { ...DEFAULT_STATE, selectedPort: "COM3" };
    expect(withDerivedFlags(state).canConnect).toBe(true);
  });

  it("cannot connect while scanning or already connecting", () => {
    const scanning = { ...DEFAULT_STATE, selectedPort: "COM3", isScanning: true };
    const connecting = { ...DEFAULT_STATE, selectedPort: "COM3", isConnecting: true };

    expect(withDerivedFlags(scanning).canConnect).toBe(false);
    expect(withDerivedFlags(connecting).canConnect).toBe(false);
  });

  it("cannot connect with no selected port", () => {
    expect(withDerivedFlags(DEFAULT_STATE).canConnect).toBe(false);
  });
});
