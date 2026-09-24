import { describe, expect, it } from "vitest";

import { LIGHTING_MODE_KIND, type LightingModeKind } from "@/shared/contracts/mode";
import { KEYBIND_ACTIONS } from "@/shared/contracts/shell";
import type { Equals } from "@/test/typeEquals";

import { MODE_KIND_ORDER, MODE_KINDS, type ModeKindDescriptor } from "../modeKinds";

describe("MODE_KINDS", () => {
  it("has exactly one row per lighting mode kind", () => {
    const covered: Equals<keyof typeof MODE_KINDS, LightingModeKind> = true;
    expect(covered).toBe(true);
    expect(Object.keys(MODE_KINDS).sort()).toEqual(Object.values(LIGHTING_MODE_KIND).sort());
    expect([...MODE_KIND_ORDER].sort()).toEqual(Object.values(LIGHTING_MODE_KIND).sort());
  });

  it("does not compile with a kind missing", () => {
    const { solid: _solid, ...withoutSolid } = MODE_KINDS;
    // @ts-expect-error — Solid has no row, so the strips could not draw it.
    const incomplete = withoutSolid satisfies Record<LightingModeKind, ModeKindDescriptor>;
    expect(Object.keys(incomplete)).not.toContain("solid");
  });

  it("maps each kind to its own keybind, the one the strip's badge shows", () => {
    expect(MODE_KINDS.off.keybind).toBe(KEYBIND_ACTIONS.MODE_OFF);
    expect(MODE_KINDS.ambilight.keybind).toBe(KEYBIND_ACTIONS.MODE_AMBILIGHT);
    expect(MODE_KINDS.solid.keybind).toBe(KEYBIND_ACTIONS.MODE_SOLID);
  });

  it("builds the config a click applies from the payloads on screen", () => {
    const solid = { r: 1, g: 2, b: 3, brightness: 0.5 };
    const ambilight = { brightness: 0.8 };
    expect(MODE_KINDS.off.config()).toEqual({ kind: "off" });
    expect(MODE_KINDS.ambilight.config({ solid, ambilight })).toEqual({ kind: "ambilight", ambilight });
    expect(MODE_KINDS.solid.config({ solid, ambilight })).toEqual({ kind: "solid", solid });
    // A keybind carries no payload: Rust keeps the last colour and settings.
    expect(MODE_KINDS.ambilight.config({})).toEqual({ kind: "ambilight" });
    expect(MODE_KINDS.solid.config({})).toEqual({ kind: "solid" });
  });
});
