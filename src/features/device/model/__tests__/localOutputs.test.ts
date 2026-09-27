import { describe, expect, it } from "vitest";

import type { DevicePort } from "../../types";
import { localSinkOf, sameDriven, wledOutput } from "../localOutputs";

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
      wledOutput({ revision: 1, outputs: [{ kind: "wled", ip: "a", ledCount: 1, connected: true }], driven: null })?.ip,
    ).toBe("a");
  });
});
