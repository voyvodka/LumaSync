import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { migrateShellState } from "../migrations";
import {
  SHELL_STATE_SCHEMA_VERSION,
  legacyField,
  makeBaseState,
} from "./support/migrationFixtures";

describe("migrateShellState — schemaVersion 2 → 3 (window center)", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("derives_center_from_legacy_corner_and_size_fields", () => {
    // Full mode: 900×620 inner, top-left at (100, 200) ⇒ center at (550, 510).
    const input = makeBaseState({
      schemaVersion: 2,
      windowX: 100,
      windowY: 200,
      windowWidth: 900,
      windowHeight: 620,
    });

    const out = migrateShellState(input);

    expect(out.schemaVersion).toBe(SHELL_STATE_SCHEMA_VERSION);
    expect(out.windowCenterX).toBe(550);
    expect(out.windowCenterY).toBe(510);

    // Legacy fields stripped from the migrated state.
    expect(legacyField(out, "windowX")).toBeUndefined();
    expect(legacyField(out, "windowY")).toBeUndefined();
    expect(legacyField(out, "windowWidth")).toBeUndefined();
    expect(legacyField(out, "windowHeight")).toBeUndefined();
  });

  it("rounds_odd_size_halves_with_Math_round", () => {
    // 901 / 2 = 450.5 → rounds to 451 (Math.round); 621 / 2 = 310.5 → 311.
    // Math.round breaks ties toward +∞, so the half-pixel bias lands one
    // pixel to the right / down — acceptable for a one-shot migration that
    // self-corrects on the next persist.
    const input = makeBaseState({
      schemaVersion: 2,
      windowX: 0,
      windowY: 0,
      windowWidth: 901,
      windowHeight: 621,
    });

    const out = migrateShellState(input);

    expect(out.windowCenterX).toBe(451);
    expect(out.windowCenterY).toBe(311);
  });

  it("nulls_center_when_all_legacy_corners_are_null", () => {
    // Fresh user that never moved the window — the legacy slot held all
    // four fields at `null`; the migration must NOT fabricate a center.
    const input = makeBaseState({
      schemaVersion: 2,
      windowX: null,
      windowY: null,
      windowWidth: null,
      windowHeight: null,
    });

    const out = migrateShellState(input);

    expect(out.schemaVersion).toBe(SHELL_STATE_SCHEMA_VERSION);
    expect(out.windowCenterX).toBeNull();
    expect(out.windowCenterY).toBeNull();
    expect(legacyField(out, "windowX")).toBeUndefined();
  });

  it("nulls_center_when_partial_corners_are_persisted", () => {
    // Defensive — width set but height null leaves the record half-baked.
    // Both center fields must land at `null` rather than mixing real and
    // synthetic values.
    const input = makeBaseState({
      schemaVersion: 2,
      windowX: 50,
      windowY: 75,
      windowWidth: 800,
      windowHeight: null,
    });

    const out = migrateShellState(input);

    expect(out.windowCenterX).toBeNull();
    expect(out.windowCenterY).toBeNull();
  });

  it("nulls_center_on_non_finite_legacy_values", () => {
    // NaN / Infinity in the persisted blob (corrupted JSON write) must
    // degrade to "no opinion" rather than poisoning the new field.
    const input = makeBaseState({
      schemaVersion: 2,
      windowX: Number.NaN,
      windowY: 0,
      windowWidth: 320,
      windowHeight: 480,
    });

    const out = migrateShellState(input);

    expect(out.windowCenterX).toBeNull();
    expect(out.windowCenterY).toBeNull();
  });

  it("strips_legacy_corner_fields_even_when_center_is_derivable", () => {
    const input = makeBaseState({
      schemaVersion: 2,
      windowX: 10,
      windowY: 20,
      windowWidth: 320,
      windowHeight: 480,
    });

    const out = migrateShellState(input);

    expect(out.windowCenterX).toBe(170);
    expect(out.windowCenterY).toBe(260);
    // None of the four legacy keys may resurface on the migrated object.
    expect(legacyField(out, "windowX")).toBeUndefined();
    expect(legacyField(out, "windowY")).toBeUndefined();
    expect(legacyField(out, "windowWidth")).toBeUndefined();
    expect(legacyField(out, "windowHeight")).toBeUndefined();
  });

  it("preserves_unrelated_optional_fields_through_the_step", () => {
    // The 2 → 3 step must only touch geometry — every other persisted
    // setting (language, lastSuccessfulPort, hasCompletedOnboarding, …)
    // must round-trip untouched.
    const input = makeBaseState({
      schemaVersion: 2,
      windowX: 0,
      windowY: 0,
      windowWidth: 900,
      windowHeight: 620,
      language: "tr",
      lastSuccessfulPort: "/dev/tty.usbserial",
      hasCompletedOnboarding: true,
      uiMode: "full",
      lastFullSize: { width: 1024, height: 720 },
    });

    const out = migrateShellState(input);

    expect(out.language).toBe("tr");
    expect(out.lastSuccessfulPort).toBe("/dev/tty.usbserial");
    expect(out.hasCompletedOnboarding).toBe(true);
    expect(out.uiMode).toBe("full");
    expect(out.lastFullSize).toEqual({ width: 1024, height: 720 });
  });
});

// ---------------------------------------------------------------------------
// 3 → 4 — recover hueZones stranded by the pre-fix Lights dock
// ---------------------------------------------------------------------------
