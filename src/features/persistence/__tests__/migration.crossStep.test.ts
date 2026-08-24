import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { migrateShellState } from "../migrations";
import {
  DEFAULT_ROOM_DIMENSIONS,
  SHELL_STATE_SCHEMA_VERSION,
  legacyField,
  makeBaseState,
  makeLegacyHueZone,
} from "./support/migrationFixtures";
import type {
  ShellState,
} from "./support/migrationFixtures";

describe("migrateShellState — cross-step contract", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("chains_v1_to_latest_in_a_single_pass", () => {
    // A v1 on-disk snapshot (legacy hueZones + legacy corner geometry)
    // must come out at the latest version with every migration applied.
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
    expect(SHELL_STATE_SCHEMA_VERSION).toBe(6);

    // 1 → 2 fold ran.
    expect(out.roomMap?.zones).toHaveLength(1);
    expect(out.roomMap?.zones[0].id).toBe("hue-1");
    expect(out.roomMap).not.toHaveProperty("hueZones");

    // 2 → 3 geometry conversion ran.
    expect(out.windowCenterX).toBe(550);
    expect(out.windowCenterY).toBe(510);
    expect(legacyField(out, "windowX")).toBeUndefined();
  });

  it("idempotent_latest_load_does_not_remigrate", () => {
    const alreadyMigrated: ShellState = {
      schemaVersion: SHELL_STATE_SCHEMA_VERSION,
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
    expect(out.schemaVersion).toBe(SHELL_STATE_SCHEMA_VERSION);
    expect(out.windowCenterX).toBe(480);
    expect(out.windowCenterY).toBe(350);
    expect(out.roomMap?.zones).toHaveLength(1);
    expect(out.roomMap).not.toHaveProperty("hueZones");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  // Deliberately negative: credential cleanup is not a migration concern —
  // see docs/architecture/hue.md.
  it("never touches the Hue credential fields at any schema version", () => {
    for (let version = 1; version <= SHELL_STATE_SCHEMA_VERSION; version += 1) {
      const state = {
        schemaVersion: version,
        hueAppKey: "app-key-abc",
        hueClientKey: "psk-deadbeef",
      } as ShellState;

      const out = migrateShellState(state);

      expect(out.hueAppKey).toBe("app-key-abc");
      expect(out.hueClientKey).toBe("psk-deadbeef");
      expect(out).not.toHaveProperty("credentialStorageBackend");
    }
  });
});

// ---------------------------------------------------------------------------
// 4 → 5 — attribute Hue channel placements to an entertainment area
// ---------------------------------------------------------------------------
