import { describe, expect, it } from "vitest";

import { deriveLocalSink } from "../localSink";

describe("deriveLocalSink", () => {
  /**
   * The bug this exists for: the Lights screen asked whether a *serial port*
   * was connected, so a WLED-only setup read as "no strip connected", every
   * non-Off mode stayed disabled, and the panel the user owned was
   * unreachable — while Rust drives it perfectly well through
   * `UsbOutputPlan::Wled`.
   */
  it("reports a WLED panel as a local sink when no serial port is connected", () => {
    expect(deriveLocalSink(false, null, "192.168.1.42")).toEqual({
      transport: "wled",
      id: "192.168.1.42",
    });
  });

  it("reports the serial strip when one is connected", () => {
    expect(deriveLocalSink(true, "/dev/cu.usbserial-1420", null)).toEqual({
      transport: "serial",
      id: "/dev/cu.usbserial-1420",
    });
  });

  /**
   * Serial wins, and not as a preference: a serial connect evicts WLED from
   * `ActiveSinkRegistry`, so Rust is driving the strip. Naming WLED here would
   * be the same class of lie this function removes.
   */
  it("names serial when both are bound, because that is what Rust is driving", () => {
    expect(deriveLocalSink(true, "/dev/cu.usbserial-1420", "192.168.1.42")).toEqual({
      transport: "serial",
      id: "/dev/cu.usbserial-1420",
    });
  });

  it("carries the USB product string of a serial strip when the OS reported one", () => {
    expect(deriveLocalSink(true, "/dev/cu.usbserial-1420", null, "USB2.0-Serial")).toEqual({
      transport: "serial",
      id: "/dev/cu.usbserial-1420",
      product: "USB2.0-Serial",
    });
    expect(deriveLocalSink(true, "/dev/cu.usbserial-1420", null, "")).toEqual({
      transport: "serial",
      id: "/dev/cu.usbserial-1420",
    });
  });

  it("reports nothing bound when neither is", () => {
    expect(deriveLocalSink(false, null, null)).toBeNull();
  });

  /** An empty string is not an address; treating it as one names a sink that
   *  does not exist, which is how the row would claim a connection it lacks. */
  it("treats an empty identifier as nothing bound", () => {
    expect(deriveLocalSink(false, "", "")).toBeNull();
    expect(deriveLocalSink(false, "", "192.168.1.42")).toEqual({
      transport: "wled",
      id: "192.168.1.42",
    });
  });
});
