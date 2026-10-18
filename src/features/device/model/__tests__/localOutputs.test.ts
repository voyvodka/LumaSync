import { describe, expect, it } from "vitest";

import type { LocalOutputsSnapshot, SerialCommandStatusCode } from "@/shared/contracts/device";

import type { DevicePort } from "../../types";
import {
  anyLocalConnected,
  classifyLoss,
  connectedSerialPort,
  localSinkOf,
  sameDriven,
  wledOutput,
} from "../localOutputs";

const ports: DevicePort[] = [
  { portName: "/dev/cu.usbserial-10", product: "USB Serial", isSupported: true, sortKey: "0" },
];

describe("localSinkOf", () => {
  it("names what the registry drives, with the port's product when the OS gave one", () => {
    expect(localSinkOf({ kind: "serial", portName: "/dev/cu.usbserial-10" }, ports)).toEqual({
      transport: "serial",
      id: "/dev/cu.usbserial-10",
      product: "USB Serial",
    });
    expect(localSinkOf({ kind: "serial", portName: "/dev/cu.other" }, ports)).toEqual({
      transport: "serial",
      id: "/dev/cu.other",
    });
  });

  // The frontend once said a strip wins over a WLED device while Rust drove the device.
  it("names the WLED device when the registry drives it, whatever else is listed", () => {
    expect(localSinkOf({ kind: "wled", ip: "192.168.1.42" }, ports)).toEqual({ transport: "wled", id: "192.168.1.42" });
  });

  it("carries a WLED device's silence, and only a WLED device's", () => {
    expect(localSinkOf({ kind: "wled", ip: "192.168.1.42" }, ports, false)).toEqual({
      transport: "wled",
      id: "192.168.1.42",
      reachable: false,
    });
    expect(localSinkOf({ kind: "serial", portName: "/dev/cu.usbserial-10" }, ports, false)).not.toHaveProperty(
      "reachable",
    );
  });

  it("names nothing when nothing is driven", () => {
    expect(localSinkOf(null, ports)).toBeNull();
  });
});

describe("sameDriven", () => {
  it("compares the output named, not the object", () => {
    expect(sameDriven({ kind: "wled", ip: "a" }, { kind: "wled", ip: "a" })).toBe(true);
    expect(sameDriven({ kind: "wled", ip: "a" }, { kind: "serial", portName: "a" })).toBe(false);
    expect(sameDriven(null, null)).toBe(true);
    expect(sameDriven(null, { kind: "wled", ip: "a" })).toBe(false);
  });
});

describe("wledOutput", () => {
  it("finds the bound device, or nothing", () => {
    expect(wledOutput(null)).toBeNull();
    expect(
      wledOutput({ revision: 1, outputs: [{ kind: "wled", ip: "a", ledCount: 1, connected: true, reachable: true }], driven: null })?.ip,
    ).toBe("a");
  });
});

const strip = (portName: string, connected: boolean, code: SerialCommandStatusCode = connected ? "CONNECT_OK" : "DISCONNECTED") =>
  ({
    kind: "serial",
    portName,
    connected,
    status: { code, message: code, details: null },
    firmware: null,
    updatedAtUnixMs: 0,
  }) as const;
const wled = (ip: string) => ({ kind: "wled", ip, ledCount: 60, connected: true, reachable: true }) as const;
const registry = (revision: number, ...outputs: LocalOutputsSnapshot["outputs"]): LocalOutputsSnapshot => ({
  revision,
  outputs,
  driven: null,
});

describe("reading the registry", () => {
  it("finds the connected strip among entries that are not", () => {
    const snapshot = registry(1, strip("COM3", false, "PORT_NOT_FOUND"), strip("COM4", true));
    expect(connectedSerialPort(snapshot)).toBe("COM4");
    expect(connectedSerialPort(registry(1, strip("COM3", false)))).toBeNull();
    expect(connectedSerialPort(null)).toBeNull();
  });

  it("counts a WLED device as a local output that is connected", () => {
    expect(anyLocalConnected(registry(1, strip("COM3", false), wled("10.0.0.5")))).toBe(true);
    expect(anyLocalConnected(registry(1, strip("COM3", false, "PORT_NOT_FOUND")))).toBe(false);
    expect(anyLocalConnected(null)).toBe(false);
  });
});

describe("classifyLoss", () => {
  it("calls a strip whose port went away unplugged", () => {
    expect(classifyLoss(registry(1, strip("COM3", true)), registry(2, strip("COM3", false, "PORT_NOT_FOUND")))).toBe(
      "unplugged",
    );
  });

  it("calls a strip let go of, or replaced by WLED, released", () => {
    expect(classifyLoss(registry(1, strip("COM3", true)), registry(2, strip("COM3", false)))).toBe("released");
    expect(classifyLoss(registry(1, strip("COM3", true)), registry(2, strip("COM3", false), wled("10.0.0.5")))).toBe(
      "released",
    );
  });

  it("calls a WLED device that was forgotten released", () => {
    expect(classifyLoss(registry(1, wled("10.0.0.5")), registry(2))).toBe("released");
  });

  // An unplug is what takes "usb" out of the targets, so it wins over a release in the same change.
  it("says unplugged when an unplug and a release land together", () => {
    const before = registry(1, strip("COM3", true), wled("10.0.0.5"));
    const after = registry(2, strip("COM3", false, "PORT_NOT_FOUND"));
    expect(classifyLoss(before, after)).toBe("unplugged");
  });

  it("finds nothing lost on a connect, a failed attempt beside the strip, or the first read", () => {
    expect(classifyLoss(registry(1), registry(2, strip("COM3", true)))).toBeNull();
    expect(
      classifyLoss(registry(1, strip("COM3", true)), registry(2, strip("COM3", true), strip("COM4", false, "CONNECT_IO_ERROR"))),
    ).toBeNull();
    expect(classifyLoss(null, registry(1, strip("COM3", false, "PORT_NOT_FOUND")))).toBeNull();
  });
});
