import { describe, expect, it } from "vitest";

import { groupAndSortPorts, resolveInitialSelection } from "./portSelection";

describe("device port selection rules", () => {
  it("groups supported ports first", () => {
    const ports = [
      { portName: "COM7", isSupported: false, sortKey: "com7" },
      { portName: "COM3", isSupported: true, sortKey: "com3" },
      { portName: "COM1", isSupported: true, sortKey: "com1" },
    ];

    const result = groupAndSortPorts(ports);

    expect(result.supported.map((port) => port.portName)).toEqual(["COM1", "COM3"]);
    expect(result.other.map((port) => port.portName)).toEqual(["COM7"]);
  });

  it("prefers remembered port on returning usage", () => {
    const ports = [
      { portName: "COM1", isSupported: true, sortKey: "com1" },
      { portName: "COM3", isSupported: true, sortKey: "com3" },
    ];

    const selected = resolveInitialSelection(ports, "COM3");

    expect(selected).toBe("COM3");
  });

  it("falls back to first supported or empty selection", () => {
    const withSupported = [
      { portName: "COM7", isSupported: false, sortKey: "com7" },
      { portName: "COM3", isSupported: true, sortKey: "com3" },
    ];

    const withoutSupported = [
      { portName: "COM7", isSupported: false, sortKey: "com7" },
      { portName: "COM8", isSupported: false, sortKey: "com8" },
    ];

    expect(resolveInitialSelection(withSupported)).toBe("COM3");
    expect(resolveInitialSelection(withoutSupported)).toBeNull();
  });
});
