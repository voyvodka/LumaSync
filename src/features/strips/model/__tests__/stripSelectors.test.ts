import { describe, expect, it } from "vitest";

import type { LegacyStripSource } from "../legacyStrips";
import {
  primaryStrip,
  primaryStripOf,
  savedSerialPort,
  savedWledSink,
} from "../stripSelectors";
import fixture from "./fixtures/legacyStrips.parity.json";

const cases = fixture.cases as unknown as {
  name: string;
  state: LegacyStripSource;
}[];

describe("selectors", () => {
  const both =
    cases.find((c) => c.name.startsWith("a port and a WLED device"))?.state ??
    {};

  it("takes the first enabled strip as the primary one", () => {
    expect(primaryStripOf(both)?.transport).toEqual({
      kind: "serial",
      portName: "COM3",
    });
    expect(primaryStrip([])).toBeUndefined();
  });

  it("finds each saved transport whether or not its strip is the primary one", () => {
    expect(savedSerialPort(both)).toBe("COM3");
    expect(savedWledSink(both)?.ip).toBe("10.0.0.5");
    expect(savedSerialPort({})).toBeUndefined();
    expect(savedWledSink({})).toBeUndefined();
  });
});
