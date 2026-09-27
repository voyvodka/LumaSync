import { describe, expect, it } from "vitest";

import { DEFAULT_COLOR_CORRECTION, type WledUdpSinkConfig } from "@/shared/contracts/device";
import { DEFAULT_SHELL_STATE, type ShellState } from "@/shared/contracts/shell";
import type { LedStrip } from "@/shared/contracts/strips";
import {
  withColorCorrection,
  withSerialTransport,
  withStripHardware,
  withStripLayout,
  withStripName,
  withWledSink,
  withWledTransport,
  withoutWledDevice,
} from "../stripWrites";

const SINK: WledUdpSinkConfig = { ip: "10.0.0.5", port: 4048, ledCount: 60, protocol: "ddp" };
const LAYOUT = { totalLeds: 60 } as never;

function state(extra: Partial<ShellState> = {}): ShellState {
  return { ...DEFAULT_SHELL_STATE, ledStrips: [], ...extra };
}

function strip(id: string, extra: Partial<LedStrip> = {}): LedStrip {
  return { id, enabled: true, transport: null, hardware: {}, ...extra };
}

function placement(stripId: string, portName?: string) {
  return { stripId, startX: 0, startY: 0, endX: 1, endY: 0, ledCount: 60, ...(portName ? { portName } : {}) };
}

describe("the first strip a write creates", () => {
  it("takes the id of the placement on its port and the global colour correction", () => {
    const current = state({
      colorCorrection: DEFAULT_COLOR_CORRECTION,
      roomMap: { ...DEFAULT_SHELL_STATE.roomMap!, usbStrips: [placement("usb-a", "COM9"), placement("usb-b", "COM3")] } as never,
    });

    expect(withSerialTransport(current, "COM3").ledStrips).toEqual([
      strip("usb-b", { transport: { kind: "serial", portName: "COM3" }, colorCorrection: DEFAULT_COLOR_CORRECTION }),
    ]);
  });

  it("falls back to the first placement's id, then strip-1", () => {
    const placed = state({ roomMap: { ...DEFAULT_SHELL_STATE.roomMap!, usbStrips: [placement("usb-a")] } as never });
    expect(withStripLayout(placed, LAYOUT).ledStrips?.[0]?.id).toBe("usb-a");
    expect(withStripLayout(state(), LAYOUT).ledStrips?.[0]?.id).toBe("strip-1");
  });
});

describe("the strip a write lands on", () => {
  it("is the first enabled one, else the first", () => {
    const both = state({ ledStrips: [strip("a", { enabled: false }), strip("b")] });
    expect(withStripHardware(both, { chipType: "sk6812-rgbw" }).ledStrips?.[1]?.hardware).toEqual({
      chipType: "sk6812-rgbw",
    });

    const none = state({ ledStrips: [strip("a", { enabled: false })] });
    expect(withStripHardware(none, { chipType: "sk6812-rgbw" }).ledStrips?.[0]?.hardware).toEqual({
      chipType: "sk6812-rgbw",
    });
  });

  it("clears a hardware field set to undefined and keeps the rest", () => {
    const current = state({ ledStrips: [strip("a", { hardware: { chipType: "sk6812-rgbw", colorOrder: "grb" } })] });
    expect(withStripHardware(current, { colorOrder: undefined }).ledStrips?.[0]?.hardware).toEqual({
      chipType: "sk6812-rgbw",
    });
  });
});

describe("colour correction", () => {
  // A Hue-only install has no strip, whatever its correction says.
  it("never creates a strip", () => {
    expect(withColorCorrection(state(), DEFAULT_COLOR_CORRECTION)).toEqual({ colorCorrection: DEFAULT_COLOR_CORRECTION });
  });

  it("writes the global key and the target strip's copy together", () => {
    const out = withColorCorrection(state({ ledStrips: [strip("a")] }), DEFAULT_COLOR_CORRECTION);
    expect(out.colorCorrection).toEqual(DEFAULT_COLOR_CORRECTION);
    expect(out.ledStrips?.[0]?.colorCorrection).toEqual(DEFAULT_COLOR_CORRECTION);
  });
});

describe("transports", () => {
  it("moves the target strip to WLED, keeping its layout, and drops a strip left on serial", () => {
    const current = state({
      ledStrips: [
        strip("a", { transport: { kind: "serial", portName: "COM3" }, layout: LAYOUT }),
        strip("b", { enabled: false, transport: { kind: "serial", portName: "COM4" } }),
        strip("c", { enabled: false }),
      ],
    });
    expect(withWledTransport(current, SINK).ledStrips).toEqual([
      strip("a", { transport: { kind: "wled", sink: SINK }, layout: LAYOUT }),
      strip("c", { enabled: false }),
    ]);
  });

  it("refreshes the saved WLED device in place, and writes nothing without one", () => {
    const current = state({ ledStrips: [strip("a", { transport: { kind: "wled", sink: SINK } })] });
    expect(withWledSink(current, { ...SINK, ledCount: 90 })?.ledStrips?.[0]?.transport).toEqual({
      kind: "wled",
      sink: { ...SINK, ledCount: 90 },
    });
    expect(withWledSink(state(), SINK)).toBeNull();
  });
});

// Mirrors `forget_wled_in` in Rust (`led_strips.rs`).
describe("withoutWledDevice", () => {
  it("keeps the primary strip's layout with no transport", () => {
    const current = state({ ledStrips: [strip("a", { transport: { kind: "wled", sink: SINK }, layout: LAYOUT })] });
    expect(withoutWledDevice(current, " 10.0.0.5 ")?.ledStrips).toEqual([strip("a", { layout: LAYOUT })]);
  });

  it("drops a waiting strip on the device and a primary one left describing nothing", () => {
    const current = state({
      ledStrips: [
        strip("a", { transport: { kind: "wled", sink: SINK } }),
        strip("b", { enabled: false, transport: { kind: "wled", sink: SINK } }),
      ],
    });
    expect(withoutWledDevice(current, "10.0.0.5")?.ledStrips).toEqual([]);
    expect(withoutWledDevice(current, "10.0.0.6")).toBeNull();
  });
});

describe("withStripName", () => {
  it("names the strip it is given, trimmed, and leaves the others", () => {
    const patch = withStripName(state({ ledStrips: [strip("a"), strip("b")] }), "b", "  Desk  ");
    expect(patch?.ledStrips).toEqual([strip("a"), strip("b", { name: "Desk" })]);
  });

  it("clears the name on a blank one, back to the device's name", () => {
    const patch = withStripName(state({ ledStrips: [strip("a", { name: "Desk" })] }), "a", "   ");
    expect(patch?.ledStrips).toEqual([strip("a")]);
  });

  // A rename must never land on the primary strip or create one.
  it("writes nothing for an id no strip has", () => {
    expect(withStripName(state({ ledStrips: [strip("a")] }), "zzz", "Desk")).toBeNull();
    expect(withStripName(state(), "a", "Desk")).toBeNull();
  });

  it("caps a long name by characters, never splitting an emoji", () => {
    const long = `${"a".repeat(39)}🎛️🎛️`;
    const name = withStripName(state({ ledStrips: [strip("a")] }), "a", long)?.ledStrips?.[0]?.name;
    expect(Array.from(name ?? "")).toHaveLength(40);
    expect(name?.endsWith("🎛")).toBe(true);
  });

  it("keeps a name through a change of transport: it belongs to the run of LEDs", () => {
    const renamed = { ...state({ ledStrips: [strip("a", { name: "Desk" })] }) };
    expect(withSerialTransport(renamed, "COM3").ledStrips?.[0]?.name).toBe("Desk");
  });
});

