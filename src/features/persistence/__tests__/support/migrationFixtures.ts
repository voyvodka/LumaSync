/**
 * Shared fixtures for the shell-state migration suite.
 *
 * The ladder itself is split one file per schema step
 * (`migration.v1ToV2.test.ts` and siblings) because each step is an
 * independent contract; this module holds only what every step builds on, so
 * a fixture change lands in one place rather than six.
 */
import {
  SHELL_STATE_SCHEMA_VERSION,
  type ShellState,
} from "@/shared/contracts/shell";
import {
  DEFAULT_ROOM_DIMENSIONS,
  type HueChannelPlacement,
  type HueZone,
  type LegacyHueZone,
  type ZoneDefinition,
} from "@/shared/contracts/roomMap";

export {
  SHELL_STATE_SCHEMA_VERSION,
  DEFAULT_ROOM_DIMENSIONS,
};
export type {
  ShellState,
  HueChannelPlacement,
  HueZone,
  LegacyHueZone,
  ZoneDefinition,
};

/**
 * Legacy on-disk shape — the four corner+size fields that lived on
 * `ShellState` at schemaVersion <= 2 but are no longer part of the
 * canonical interface. Tests inject these via the `legacyGeometry`
 * helper to faithfully reproduce a v1/v2 persisted snapshot.
 */
export type LegacyWindowGeometry = {
  windowX?: number | null;
  windowY?: number | null;
  windowWidth?: number | null;
  windowHeight?: number | null;
};

export function makeBaseState(
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

export function makeLegacyHueZone(
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

export function makeLegacyZoneDefinition(
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
export function asZonesSlot(legacy: Array<unknown>): HueZone[] {
  return legacy as unknown as HueZone[];
}

/**
 * Helper — read a legacy field off a migrated `ShellState` for negative
 * assertions ("legacy field stripped"). Avoids strewing type-casts
 * across every assertion call site.
 */
export function legacyField(
  state: ShellState,
  key: keyof LegacyWindowGeometry,
): unknown {
  return (state as unknown as Record<string, unknown>)[key];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

