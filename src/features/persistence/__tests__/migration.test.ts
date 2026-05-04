/**
 * Shell State Migration — chained schemaVersion upgrades
 *
 * Behaviour the migration shim guarantees today:
 *
 * 1 → 2 (W4-F2 — post-direction-reversal):
 *  - Legacy `roomMap.hueZones[]` (the v1.5 W1-A1 `LegacyHueZone[]` shape)
 *    is folded into the unified `roomMap.zones: HueZone[]` array; the
 *    deprecated `hueZones` field is dropped from the migrated state.
 *  - Legacy `ZoneDefinition[]` records (the brief W4-F unification
 *    dev-branch shape — `id` / `name` / `channelIndices` only, no
 *    `entertainmentAreaId`) leaked into `roomMap.zones[]` are DROPPED
 *    with a single aggregate `console.warn` line. The "logical zone"
 *    concept itself was removed in W4-F2; future zone kinds will land
 *    under explicit prefixes (`ScreenZone` / `LedZone`).
 *  - Corrupt Hue records (NaN coordinates, empty `entertainmentAreaId`,
 *    missing required fields) are dropped and emit per-record
 *    `console.warn` lines; valid records on the same array survive.
 *
 * 2 → 3 (window-geometry center-point migration):
 *  - The retired corner-anchored fields
 *    (`windowX` / `windowY` / `windowWidth` / `windowHeight`) are read
 *    once and folded into the new mode-invariant pair
 *    (`windowCenterX` / `windowCenterY`).
 *  - Any of the four legacy fields `null` / non-finite ⇒ both center
 *    fields land at `null` (defensive — incomplete corner record means
 *    the on-disk state is untrustworthy for derivation).
 *  - The four legacy fields are stripped from the migrated state.
 *
 * Cross-step contract — the shim is idempotent, so running it on a
 * state that is already at `SHELL_STATE_SCHEMA_VERSION` returns the
 * input unchanged (no double-conversion, no mutation).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { migrateShellState } from "../migrations";
import {
  SHELL_STATE_SCHEMA_VERSION,
  type ShellState,
} from "../../../shared/contracts/shell";
import {
  DEFAULT_ROOM_DIMENSIONS,
  type HueZone,
  type LegacyHueZone,
  type ZoneDefinition,
} from "../../../shared/contracts/roomMap";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Legacy on-disk shape — the four corner+size fields that lived on
 * `ShellState` at schemaVersion ≤ 2 but are no longer part of the
 * canonical interface. Tests inject these via the `legacyGeometry`
 * helper to faithfully reproduce a v1/v2 persisted snapshot.
 */
type LegacyWindowGeometry = {
  windowX?: number | null;
  windowY?: number | null;
  windowWidth?: number | null;
  windowHeight?: number | null;
};

/**
 * Build a v1 base shell state (the pre-W4-F shape — `schemaVersion: 1`,
 * legacy corner+size geometry slot defaults to all-`null`).
 *
 * The legacy fields are injected via a type-cast because they no longer
 * appear on the canonical `ShellState` interface. The migration shim
 * still reads them off untyped persisted state, so the test fixture
 * mirrors that shape exactly.
 */
function makeBaseState(
  overrides: Partial<ShellState> & LegacyWindowGeometry = {},
): ShellState {
  const legacyGeometry: LegacyWindowGeometry = {
    windowWidth: overrides.windowWidth ?? null,
    windowHeight: overrides.windowHeight ?? null,
    windowX: overrides.windowX ?? null,
    windowY: overrides.windowY ?? null,
  };

  // Strip legacy keys off `overrides` so the spread below doesn't
  // double-merge them through the cast.
  const {
    windowWidth: _w,
    windowHeight: _h,
    windowX: _x,
    windowY: _y,
    ...canonicalOverrides
  } = overrides;
  void _w;
  void _h;
  void _x;
  void _y;

  const base: ShellState = {
    schemaVersion: 1,
    windowCenterX: null,
    windowCenterY: null,
    lastSection: "lights",
    trayHintShown: false,
    startupEnabled: false,
    ...canonicalOverrides,
  };

  return { ...base, ...legacyGeometry } as unknown as ShellState;
}

function makeLegacyHueZone(
  overrides: Partial<LegacyHueZone> = {},
): LegacyHueZone {
  return {
    id: "hue-zone-1",
    name: "Sofa back",
    entertainmentAreaId: "ea-living-room",
    centerX: 0,
    centerY: 0,
    centerZ: 0,
    scaleX: 0.5,
    scaleY: 0.5,
    scaleZ: 0.5,
    channelIndices: [0, 1, 2],
    borderColor: "#f59e0b",
    ...overrides,
  };
}

function makeLegacyZoneDefinition(
  overrides: Partial<ZoneDefinition> = {},
): ZoneDefinition {
  return {
    id: "logical-zone-1",
    name: "TV strip",
    channelIndices: [4, 5, 6, 7],
    region: "back",
    ...overrides,
  };
}

/**
 * Helper — coerce a legacy array (`ZoneDefinition[]` / mixed) into the slot
 * the contract types as `HueZone[]`. The runtime `migrateShellState` shim
 * inspects shape per-record, so passing a legacy array exercises exactly
 * the production path.
 */
function asZonesSlot(legacy: Array<unknown>): HueZone[] {
  return legacy as unknown as HueZone[];
}

/**
 * Helper — read a legacy field off a migrated `ShellState` for negative
 * assertions ("legacy field stripped"). Avoids strewing type-casts
 * across every assertion call site.
 */
function legacyField(
  state: ShellState,
  key: keyof LegacyWindowGeometry,
): unknown {
  return (state as unknown as Record<string, unknown>)[key];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("migrateShellState — schemaVersion 1 → 2 (W4-F2)", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("migrates_v1_state_with_legacy_hueZones_into_v2_zones", () => {
    const legacyHue = makeLegacyHueZone({
      id: "hz-back",
      name: "Back wall",
      entertainmentAreaId: "ea-living",
      centerX: 0.1,
      centerY: -0.2,
      centerZ: 0.3,
      scaleX: 0.4,
      scaleY: 0.5,
      scaleZ: 0.6,
      channelIndices: [0, 1, 2],
      borderColor: "#ff0",
    });

    const input = makeBaseState({
      schemaVersion: 1,
      roomMap: {
        dimensions: DEFAULT_ROOM_DIMENSIONS,
        hueChannels: [],
        usbStrips: [],
        furniture: [],
        zones: [],
        hueZones: [legacyHue],
        imageLayers: [],
      },
    });

    const out = migrateShellState(input);

    // After the chained 1 → 2 → 3 run, schemaVersion lands at the latest
    // version (3). The Hue-zone fold is still observable.
    expect(out.schemaVersion).toBe(SHELL_STATE_SCHEMA_VERSION);
    expect(out.roomMap?.zones).toHaveLength(1);
    expect(out.roomMap?.zones[0]).toMatchObject({
      id: "hz-back",
      name: "Back wall",
      entertainmentAreaId: "ea-living",
      centerX: 0.1,
      centerY: -0.2,
      centerZ: 0.3,
      scaleX: 0.4,
      scaleY: 0.5,
      scaleZ: 0.6,
      channelIndices: [0, 1, 2],
      borderColor: "#ff0",
    });
    // The W4-F-era discriminator must NOT survive — Hue zones are now
    // simply `HueZone`, no `zoneType` field.
    expect(out.roomMap?.zones[0]).not.toHaveProperty("zoneType");
    // Deprecated field must be stripped.
    expect(out.roomMap).not.toHaveProperty("hueZones");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("drops_legacy_logical_zones_with_warn_log", () => {
    const logicalA = makeLegacyZoneDefinition({ id: "log-a", name: "Log A" });
    const logicalB = makeLegacyZoneDefinition({ id: "log-b", name: "Log B" });

    const input = makeBaseState({
      schemaVersion: 1,
      roomMap: {
        dimensions: DEFAULT_ROOM_DIMENSIONS,
        hueChannels: [],
        usbStrips: [],
        furniture: [],
        zones: asZonesSlot([logicalA, logicalB]),
        hueZones: [],
        imageLayers: [],
      },
    });

    const out = migrateShellState(input);

    expect(out.schemaVersion).toBe(SHELL_STATE_SCHEMA_VERSION);
    // Logical zones are dropped entirely after W4-F2 — no migrated entries.
    expect(out.roomMap?.zones).toHaveLength(0);
    expect(out.roomMap).not.toHaveProperty("hueZones");

    // Single aggregate warn line (not per-record).
    expect(warnSpy.mock.calls.length).toBe(1);
    const warnText = warnSpy.mock.calls
      .map((call: unknown[]) => String(call[0]))
      .join(" | ");
    expect(warnText).toContain("logical zones");
    expect(warnText).toContain("count: 2");
  });

  it("merges_legacy_hueZones_into_zones_dropping_logical_leftovers", () => {
    const logicalLeftover = makeLegacyZoneDefinition({
      id: "log-stale",
      name: "Stale logical",
    });
    const hueA = makeLegacyHueZone({ id: "hue-a", name: "Hue A" });
    const hueB = makeLegacyHueZone({ id: "hue-b", name: "Hue B" });

    const input = makeBaseState({
      schemaVersion: 1,
      roomMap: {
        dimensions: DEFAULT_ROOM_DIMENSIONS,
        hueChannels: [],
        usbStrips: [],
        furniture: [],
        // Logical leftover sits in the `zones` slot from a brief W4-F dev
        // build; legacy hue array still holds the original W1-A1 records.
        zones: asZonesSlot([logicalLeftover]),
        hueZones: [hueA, hueB],
        imageLayers: [],
      },
    });

    const out = migrateShellState(input);

    expect(out.schemaVersion).toBe(SHELL_STATE_SCHEMA_VERSION);
    // Logical dropped; both Hue zones survive in declaration order.
    expect(out.roomMap?.zones).toHaveLength(2);
    expect(out.roomMap?.zones.map((z) => z.id)).toEqual(["hue-a", "hue-b"]);

    // Aggregate warn for the dropped logical leftover.
    const warnText = warnSpy.mock.calls
      .map((call: unknown[]) => String(call[0]))
      .join(" | ");
    expect(warnText).toContain("logical zones");
    expect(warnText).toContain("count: 1");

    expect(out.roomMap).not.toHaveProperty("hueZones");
  });

  it("drops_corrupt_legacy_records_with_warn_log", () => {
    const validHue = makeLegacyHueZone({
      id: "hue-valid",
      name: "Valid",
      entertainmentAreaId: "ea-1",
    });
    const corruptHueNaNScale = makeLegacyHueZone({
      id: "hue-corrupt-scale",
      name: "Bad scale",
      entertainmentAreaId: "ea-1",
      scaleX: Number.NaN,
    });
    const corruptHueEmptyArea = makeLegacyHueZone({
      id: "hue-corrupt-area",
      name: "Bad area",
      entertainmentAreaId: "",
    });

    const input = makeBaseState({
      schemaVersion: 1,
      roomMap: {
        dimensions: DEFAULT_ROOM_DIMENSIONS,
        hueChannels: [],
        usbStrips: [],
        furniture: [],
        zones: [],
        hueZones: [validHue, corruptHueNaNScale, corruptHueEmptyArea],
        imageLayers: [],
      },
    });

    const out = migrateShellState(input);

    expect(out.schemaVersion).toBe(SHELL_STATE_SCHEMA_VERSION);
    expect(out.roomMap?.zones).toHaveLength(1);
    expect(out.roomMap?.zones[0].id).toBe("hue-valid");

    // Two corrupt hue records ⇒ two per-record warn lines.
    expect(warnSpy.mock.calls.length).toBe(2);
    const warnText = warnSpy.mock.calls
      .map((call: unknown[]) => String(call[0]))
      .join(" | ");
    expect(warnText).toContain("corrupt");
  });
});

// ---------------------------------------------------------------------------
// 2 → 3 — window geometry center-point migration
// ---------------------------------------------------------------------------

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

    expect(out.schemaVersion).toBe(3);
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

    expect(out.schemaVersion).toBe(3);
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
// Cross-step contract — chained migration + idempotency
// ---------------------------------------------------------------------------

describe("migrateShellState — cross-step contract", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("chains_v1_to_v3_in_a_single_pass", () => {
    // A v1 on-disk snapshot (legacy hueZones + legacy corner geometry)
    // must come out at schemaVersion 3 with both migrations applied.
    const legacyHue = makeLegacyHueZone({
      id: "hue-1",
      name: "First",
      entertainmentAreaId: "ea-1",
    });

    const input = makeBaseState({
      schemaVersion: 1,
      windowX: 100,
      windowY: 200,
      windowWidth: 900,
      windowHeight: 620,
      roomMap: {
        dimensions: DEFAULT_ROOM_DIMENSIONS,
        hueChannels: [],
        usbStrips: [],
        furniture: [],
        zones: [],
        hueZones: [legacyHue],
        imageLayers: [],
      },
    });

    const out = migrateShellState(input);

    expect(out.schemaVersion).toBe(SHELL_STATE_SCHEMA_VERSION);
    expect(SHELL_STATE_SCHEMA_VERSION).toBe(3);

    // 1 → 2 fold ran.
    expect(out.roomMap?.zones).toHaveLength(1);
    expect(out.roomMap?.zones[0].id).toBe("hue-1");
    expect(out.roomMap).not.toHaveProperty("hueZones");

    // 2 → 3 geometry conversion ran.
    expect(out.windowCenterX).toBe(550);
    expect(out.windowCenterY).toBe(510);
    expect(legacyField(out, "windowX")).toBeUndefined();
  });

  it("idempotent_v3_load_does_not_remigrate", () => {
    const alreadyMigrated: ShellState = {
      schemaVersion: 3,
      windowCenterX: 480,
      windowCenterY: 350,
      lastSection: "lights",
      trayHintShown: false,
      startupEnabled: false,
      roomMap: {
        dimensions: DEFAULT_ROOM_DIMENSIONS,
        hueChannels: [],
        usbStrips: [],
        furniture: [],
        zones: [
          {
            id: "z-existing",
            name: "Already migrated",
            entertainmentAreaId: "ea-1",
            centerX: 0,
            centerY: 0,
            centerZ: 0,
            scaleX: 1,
            scaleY: 1,
            scaleZ: 1,
            channelIndices: [0, 1],
          },
        ],
        imageLayers: [],
      },
    };

    const out = migrateShellState(alreadyMigrated);

    // Pure noop — same reference is acceptable, and the contents must be
    // bit-equal to the input.
    expect(out).toBe(alreadyMigrated);
    expect(out.schemaVersion).toBe(3);
    expect(out.windowCenterX).toBe(480);
    expect(out.windowCenterY).toBe(350);
    expect(out.roomMap?.zones).toHaveLength(1);
    expect(out.roomMap).not.toHaveProperty("hueZones");
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
