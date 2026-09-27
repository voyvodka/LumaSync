import { describe, expect, it } from "vitest";

import { deviceRailEntries } from "../deviceRail";

const hue = (found: { id: string; name: string; ip: string }[], pairedBridgeId: string | null = null) => ({
  bridgeName: pairedBridgeId ? "Salon" : null,
  pairedBridgeId,
  streaming: false,
  found,
});

describe("deviceRailEntries", () => {
  it("puts what was found last, so a cable or a scan never moves a row above it", () => {
    const entries = deviceRailEntries({
      strips: [],
      ports: [{ portName: "COM3", isSupported: true, sortKey: "COM3" }],
      connectedPort: null,
      activeWledIp: null,
      hue: hue([{ id: "b1", name: "Salon", ip: "10.0.0.2" }, { id: "b2", name: "Hue Bridge (10.0.0.3)", ip: "10.0.0.3" }], "b1"),
    });

    expect(entries.map((entry) => entry.kind)).toEqual(["add", "hue", "port", "bridge"]);
  });

  it("names two found bridges by address when they would read the same", () => {
    const entries = deviceRailEntries({
      strips: [],
      ports: [],
      connectedPort: null,
      activeWledIp: null,
      hue: hue([
        { id: "b2", name: "Hue Bridge (10.0.0.3)", ip: "10.0.0.3" },
        { id: "b3", name: "Hue Bridge (10.0.0.4)", ip: "10.0.0.4" },
        { id: "b4", name: "Salon", ip: "10.0.0.5" },
      ]),
    });

    const bridges = entries.flatMap((entry) => (entry.kind === "bridge" ? [entry.sameNameAsAnother] : []));
    expect(bridges).toEqual([true, true, false]);
  });
});
