/**
 * Shell State Migration — schemaVersion 1 → 2 (W4-F6)
 *
 * Behaviour the migration shim guarantees:
 *
 *  1. Legacy `roomMap.hueZones[]` is folded into the unified `roomMap.zones[]`
 *     with `zoneType: "hue"`; the deprecated `hueZones` field is dropped
 *     from the migrated state.
 *  2. Legacy `roomMap.zones[]` (carrying the v1 `ZoneDefinition` shape with
 *     no `zoneType` discriminator) is converted to `Zone` records with
 *     `zoneType: "logical"`.
 *  3. When both arrays are populated they merge into a single `zones[]`
 *     preserving original ids — no duplicate elimination, no reorder.
 *  4. Corrupt records (NaN coordinates, empty `entertainmentAreaId`,
 *     missing required fields) are dropped and emit a `console.warn` line;
 *     valid records on the same array survive.
 *  5. The shim is idempotent — running it on a state that is already at
 *     `schemaVersion: 2` returns it unchanged (no double-conversion, no
 *     mutation).
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
  type Zone,
  type ZoneDefinition,
  ZONE_TYPES,
} from "../../../shared/contracts/roomMap";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeBaseState(overrides: Partial<ShellState> = {}): ShellState {
  return {
    schemaVersion: 1,
    windowWidth: null,
    windowHeight: null,
    windowX: null,
    windowY: null,
    lastSection: "lights",
    trayHintShown: false,
    startupEnabled: false,
    ...overrides,
  };
}

function makeLegacyHueZone(overrides: Partial<HueZone> = {}): HueZone {
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
 * Helper — coerce a legacy `ZoneDefinition[]` into the slot the contract types
 * as `Zone[]`. The runtime `migrateShellState` shim narrows on `zoneType`
 * presence, so passing a legacy shape is exactly the production path.
 */
function asZonesSlot(legacy: Array<ZoneDefinition | Zone>): Zone[] {
  return legacy as unknown as Zone[];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("migrateShellState — schemaVersion 1 → 2", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("migrates_v1_state_with_hueZones_array_to_v2_zones_with_zoneType_hue", () => {
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

    expect(out.schemaVersion).toBe(SHELL_STATE_SCHEMA_VERSION);
    expect(out.roomMap?.zones).toHaveLength(1);
    expect(out.roomMap?.zones[0]).toMatchObject({
      id: "hz-back",
      name: "Back wall",
      zoneType: ZONE_TYPES.HUE,
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
    // Deprecated field must be stripped.
    expect(out.roomMap).not.toHaveProperty("hueZones");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("migrates_v1_state_with_legacy_zones_to_v2_zones_with_zoneType_logical", () => {
    const legacy = makeLegacyZoneDefinition({
      id: "lz-tv",
      name: "TV ambient",
      channelIndices: [10, 11, 12, 13],
      region: "back",
    });

    const input = makeBaseState({
      schemaVersion: 1,
      roomMap: {
        dimensions: DEFAULT_ROOM_DIMENSIONS,
        hueChannels: [],
        usbStrips: [],
        furniture: [],
        zones: asZonesSlot([legacy]),
        hueZones: [],
        imageLayers: [],
      },
    });

    const out = migrateShellState(input);

    expect(out.schemaVersion).toBe(SHELL_STATE_SCHEMA_VERSION);
    expect(out.roomMap?.zones).toHaveLength(1);
    expect(out.roomMap?.zones[0]).toMatchObject({
      id: "lz-tv",
      name: "TV ambient",
      zoneType: ZONE_TYPES.LOGICAL,
      channelIndices: [10, 11, 12, 13],
      region: "back",
    });
    // Logical zones MUST NOT carry Hue-only fields after migration.
    expect(out.roomMap?.zones[0].entertainmentAreaId).toBeUndefined();
    expect(out.roomMap?.zones[0].centerX).toBeUndefined();
    expect(out.roomMap?.zones[0].scaleX).toBeUndefined();
    expect(out.roomMap).not.toHaveProperty("hueZones");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("merges_both_arrays_into_single_zones_array_preserving_ids", () => {
    const logicalA = makeLegacyZoneDefinition({ id: "log-a", name: "Log A" });
    const logicalB = makeLegacyZoneDefinition({ id: "log-b", name: "Log B" });
    const hueA = makeLegacyHueZone({ id: "hue-a", name: "Hue A" });
    const hueB = makeLegacyHueZone({ id: "hue-b", name: "Hue B" });

    const input = makeBaseState({
      schemaVersion: 1,
      roomMap: {
        dimensions: DEFAULT_ROOM_DIMENSIONS,
        hueChannels: [],
        usbStrips: [],
        furniture: [],
        zones: asZonesSlot([logicalA, logicalB]),
        hueZones: [hueA, hueB],
        imageLayers: [],
      },
    });

    const out = migrateShellState(input);

    expect(out.schemaVersion).toBe(SHELL_STATE_SCHEMA_VERSION);
    expect(out.roomMap?.zones).toHaveLength(4);

    const ids = out.roomMap?.zones.map((z) => z.id) ?? [];
    expect(ids).toEqual(["log-a", "log-b", "hue-a", "hue-b"]);

    const types = out.roomMap?.zones.map((z) => z.zoneType) ?? [];
    expect(types).toEqual([
      ZONE_TYPES.LOGICAL,
      ZONE_TYPES.LOGICAL,
      ZONE_TYPES.HUE,
      ZONE_TYPES.HUE,
    ]);

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

    const validLogical = makeLegacyZoneDefinition({
      id: "log-valid",
      name: "Valid logical",
    });
    const corruptLogicalNoId = makeLegacyZoneDefinition({
      id: "",
      name: "Missing id",
    });
    const corruptLogicalNoName = makeLegacyZoneDefinition({
      id: "log-no-name",
      name: "",
    });

    const input = makeBaseState({
      schemaVersion: 1,
      roomMap: {
        dimensions: DEFAULT_ROOM_DIMENSIONS,
        hueChannels: [],
        usbStrips: [],
        furniture: [],
        zones: asZonesSlot([validLogical, corruptLogicalNoId, corruptLogicalNoName]),
        hueZones: [validHue, corruptHueNaNScale, corruptHueEmptyArea],
        imageLayers: [],
      },
    });

    const out = migrateShellState(input);

    expect(out.schemaVersion).toBe(SHELL_STATE_SCHEMA_VERSION);

    // Two valid records survive (1 logical + 1 hue), four corrupt dropped.
    expect(out.roomMap?.zones).toHaveLength(2);
    expect(out.roomMap?.zones.map((z) => z.id)).toEqual([
      "log-valid",
      "hue-valid",
    ]);

    // Exactly one warn per corrupt record (4 total).
    expect(warnSpy.mock.calls.length).toBe(4);
    // At least one of the warn lines must mention "corrupt" so the user can
    // grep the dev console without knowing the precise message text.
    const warnText = warnSpy.mock.calls
      .map((call: unknown[]) => String(call[0]))
      .join(" | ");
    expect(warnText).toContain("corrupt");
  });

  it("idempotent_v2_load_does_not_remigrate", () => {
    const alreadyMigrated = makeBaseState({
      schemaVersion: 2,
      roomMap: {
        dimensions: DEFAULT_ROOM_DIMENSIONS,
        hueChannels: [],
        usbStrips: [],
        furniture: [],
        zones: [
          {
            id: "z-existing",
            name: "Already migrated",
            zoneType: ZONE_TYPES.HUE,
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
    });

    const out = migrateShellState(alreadyMigrated);

    // Pure noop — same reference is acceptable, and the contents must be
    // bit-equal to the input (no field reordering, no `hueZones` resurrection).
    expect(out).toBe(alreadyMigrated);
    expect(out.schemaVersion).toBe(2);
    expect(out.roomMap?.zones).toHaveLength(1);
    expect(out.roomMap?.zones[0].id).toBe("z-existing");
    expect(out.roomMap).not.toHaveProperty("hueZones");
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
