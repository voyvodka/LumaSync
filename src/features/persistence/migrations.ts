/**
 * Shell State Migrations
 *
 * Pure, testable upgrade functions that bring a previously persisted
 * `ShellState` snapshot up to the current `SHELL_STATE_SCHEMA_VERSION`. The
 * `loadShellState` path in `windowLifecycle.ts` runs these on every read,
 * idempotent by design — once a state is at the latest schema version the
 * helper short-circuits and returns the input unchanged.
 *
 * v1.5 W4-F6 introduces the `1 → 2` step that folds the deprecated
 * `RoomMapConfig.hueZones?: HueZone[]` and the legacy `ZoneDefinition[]`
 * shape of `zones` into the unified `Zone[]` array gated by the
 * `zoneType: "logical" | "hue"` discriminator. The two pure helpers
 * `toLogicalZone` / `toHueZone` (in `shared/contracts/roomMap.ts`) do the
 * per-record conversion and return `null` on corrupt inputs; this shim
 * filters those nulls so the migrated state never carries half-formed
 * zones.
 */

import {
  toHueZone,
  toLogicalZone,
  type HueZone,
  type Zone,
  type ZoneDefinition,
} from "../../shared/contracts/roomMap";
import {
  SHELL_STATE_SCHEMA_VERSION,
  type ShellState,
} from "../../shared/contracts/shell";

// ---------------------------------------------------------------------------
// 1 → 2 — unify `zones` and drop `hueZones`
// ---------------------------------------------------------------------------

/**
 * Apply the `schemaVersion 1 → 2` zone-unification migration to a single
 * `ShellState` snapshot. Pure function — does not touch plugin-store, does
 * not produce side effects beyond `console.warn` calls emitted by the
 * per-record `toLogicalZone` / `toHueZone` corrupt-input gates.
 *
 * Behaviour:
 * - `state.schemaVersion === undefined` is treated as `1` (legacy
 *   pre-v1.5 shape, which lacks the field but carries the same on-disk
 *   layout as v1.5 schema 1).
 * - `state.schemaVersion >= 2` returns the input unchanged (idempotent —
 *   safe to call on every load).
 * - `state.schemaVersion === 1` produces a NEW state object with:
 *   - `roomMap.zones` replaced by the merged unified array (legacy
 *     `ZoneDefinition[]` mapped through `toLogicalZone`, legacy
 *     `HueZone[]` mapped through `toHueZone`, nulls filtered out).
 *   - `roomMap.hueZones` deleted.
 *   - `schemaVersion` set to `SHELL_STATE_SCHEMA_VERSION` (2).
 * - `state.roomMap === undefined` (fresh user) ⇒ no `roomMap` mutation;
 *   only the `schemaVersion` bump is applied.
 *
 * Errors during conversion are swallowed (the warn log is the trail) so a
 * single corrupt persisted record cannot brick the load path. RFC §7 #1.
 */
export function migrateShellState(state: ShellState): ShellState {
  const currentVersion = state.schemaVersion ?? 1;
  if (currentVersion >= SHELL_STATE_SCHEMA_VERSION) {
    return state;
  }

  let next = state;

  // 1 → 2: zone unification + hueZones drop
  if (currentVersion < 2) {
    next = migrateV1ToV2(next);
  }

  return next;
}

/**
 * Internal — collapse `roomMap.zones` (legacy `ZoneDefinition[]`) and
 * `roomMap.hueZones` (legacy `HueZone[]`) into a single unified
 * `Zone[]`. Drops corrupt records via the helper-level null gate.
 *
 * The cast on `state.roomMap.zones` is unavoidable: the contract type for
 * `RoomMapConfig.zones` is already the new unified `Zone[]` (F1 widened
 * it), but a v1 on-disk snapshot stores the legacy `ZoneDefinition[]` shape
 * there. We narrow at runtime via `toLogicalZone`'s shape gate, not via
 * the type system.
 */
function migrateV1ToV2(state: ShellState): ShellState {
  const room = state.roomMap;

  if (!room) {
    // Fresh user without a persisted room map — only bump the schema.
    return { ...state, schemaVersion: 2 };
  }

  // Legacy v1 read: `zones` carries `ZoneDefinition` shape (no `zoneType`).
  // We treat anything without a `zoneType` discriminator as a legacy
  // logical zone; if a record already carries `zoneType` (e.g. a partially
  // migrated state, or a hand-edited dev build), pass it through as-is so
  // re-running the shim on a half-migrated file does not double-convert.
  const legacyZonesRaw = (room.zones ?? []) as unknown as Array<
    ZoneDefinition | Zone
  >;
  const legacyHueZonesRaw = (room.hueZones ?? []) as HueZone[];

  const convertedLogicalZones: Zone[] = [];
  for (const legacy of legacyZonesRaw) {
    if (
      typeof legacy === "object" &&
      legacy !== null &&
      "zoneType" in legacy &&
      typeof (legacy as Zone).zoneType === "string"
    ) {
      // Already-unified record (idempotent re-run path) — keep as-is.
      convertedLogicalZones.push(legacy as Zone);
      continue;
    }
    const converted = toLogicalZone(legacy as ZoneDefinition);
    if (converted) convertedLogicalZones.push(converted);
  }

  const convertedHueZones: Zone[] = [];
  for (const legacy of legacyHueZonesRaw) {
    const converted = toHueZone(legacy);
    if (converted) convertedHueZones.push(converted);
  }

  const mergedZones: Zone[] = [...convertedLogicalZones, ...convertedHueZones];

  // Drop the deprecated `hueZones` field on the migrated room map. We
  // structurally rebuild rather than `delete next.roomMap.hueZones` so
  // the migration is observable through deep equality.
  const { hueZones: _drop, ...roomWithoutHueZones } = room;
  void _drop;

  return {
    ...state,
    schemaVersion: 2,
    roomMap: {
      ...roomWithoutHueZones,
      zones: mergedZones,
    },
  };
}
