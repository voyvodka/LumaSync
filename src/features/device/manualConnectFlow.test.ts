import { describe, expect, it } from "vitest";

import {
  canConnectSelectedPort,
  resolveSelectionAfterRefresh,
  shouldTriggerConnectOnSelectionChange,
} from "./portSelection";

describe("manual connect flow", () => {
  it("manual fallback connect requires explicit action", () => {
    expect(shouldTriggerConnectOnSelectionChange()).toBe(false);
    expect(canConnectSelectedPort("COM7", false)).toBe(true);
    expect(canConnectSelectedPort("COM7", true)).toBe(false);
  });

  it("clears stale selection when selected port is missing after refresh", () => {
    const ports = [
      { portName: "COM3", isSupported: true, sortKey: "com3" },
      { portName: "COM7", isSupported: false, sortKey: "com7" },
    ];

    const result = resolveSelectionAfterRefresh(ports, "COM5", "COM5");

    expect(result.selectedPort).toBeNull();
    expect(result.missingSelection).toBe(true);
  });

  it("reselects remembered port when it reappears after refresh", () => {
    const ports = [
      { portName: "COM3", isSupported: true, sortKey: "com3" },
      { portName: "COM5", isSupported: false, sortKey: "com5" },
    ];

    const result = resolveSelectionAfterRefresh(ports, null, "COM5");

    expect(result.selectedPort).toBe("COM5");
    expect(result.missingSelection).toBe(false);
  });
});
