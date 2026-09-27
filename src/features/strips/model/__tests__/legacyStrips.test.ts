import { describe, expect, it } from "vitest";

import type { LedStrip } from "@/shared/contracts/strips";
import { stripsFromLegacy, type LegacyStripSource } from "../legacyStrips";
import fixture from "./fixtures/legacyStrips.parity.json";

const cases = fixture.cases as unknown as {
  name: string;
  state: LegacyStripSource;
  strips: LedStrip[];
}[];

describe("stripsFromLegacy", () => {
  // Rust reads the same file (`led_strips.rs`), so the two cannot drift apart unnoticed.
  it.each(cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    expect(stripsFromLegacy(c.state)).toEqual(c.strips);
  });
});
