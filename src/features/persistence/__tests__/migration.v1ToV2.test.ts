import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { migrateShellState } from "../migrations";
import {
  DEFAULT_ROOM_DIMENSIONS,
  SHELL_STATE_SCHEMA_VERSION,
  asZonesSlot,
  makeBaseState,
  makeLegacyHueZone,
  makeLegacyZoneDefinition,
} from "./support/migrationFixtures";

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
