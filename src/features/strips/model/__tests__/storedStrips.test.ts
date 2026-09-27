import { describe, expect, it } from "vitest";

import type { LedStrip } from "@/shared/contracts/strips";
import { readStoredStrips } from "../storedStrips";
import fixture from "./fixtures/storedStrips.parity.json";

const cases = fixture.cases as unknown as { name: string; stored: unknown; strips: LedStrip[] }[];

/** The fields both sides read; what Rust compares against the fixture. */
function known(strip: LedStrip) {
  const { id, enabled, transport, hardware, layout, colorCorrection } = strip;
  const hw = hardware as Record<string, unknown>;
  return {
    id,
    enabled,
    transport:
      transport?.kind === "serial"
        ? { kind: "serial", portName: transport.portName }
        : transport?.kind === "wled"
          ? { kind: "wled", sink: transport.sink }
          : null,
    hardware: Object.fromEntries(
      (["firmwareProfile", "chipType", "colorOrder"] as const).filter((key) => hw[key] !== undefined).map((key) => [key, hw[key]]),
    ),
    ...(layout !== undefined ? { layout } : {}),
    ...(colorCorrection !== undefined ? { colorCorrection } : {}),
  };
}

describe("readStoredStrips", () => {
  // Rust reads the same file (`led_strips.rs`), so the two cannot drift apart unnoticed.
  it.each(cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    expect(readStoredStrips(c.stored).map(known)).toEqual(c.strips);
  });

  // A later build's fields must survive this build's next write.
  it("keeps fields it does not know on the strip, its transport and its hardware", () => {
    const [strip] = readStoredStrips([
      {
        id: "s1",
        enabled: true,
        name: "desk",
        transport: { kind: "serial", portName: "COM3", serialNumber: "A1" },
        hardware: { chipType: "sk6812-rgbw", provenance: { chipType: "device" } },
      },
    ]);
    expect(strip).toMatchObject({
      name: "desk",
      transport: { serialNumber: "A1" },
      hardware: { provenance: { chipType: "device" } },
    });
  });
});
