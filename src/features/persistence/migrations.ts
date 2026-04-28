/**
 * Shell State Migrations
 *
 * Pure, testable upgrade functions that bring a previously persisted
 * `ShellState` snapshot up to the current `SHELL_STATE_SCHEMA_VERSION`. The
 * `loadShellState` path in `windowLifecycle.ts` runs these on every read,
 * idempotent by design — once a state is at the latest schema version the
 * helper short-circuits and returns the input unchanged.
 *
 * v1.5 W4-F2 (post-direction-reversal) — the `1 → 2` step folds the
 * deprecated `RoomMapConfig.hueZones?: LegacyHueZone[]` array into the
 * unified `RoomMapConfig.zones: HueZone[]` array (Hue-only). The brief
 * W4-F unification (logical + Hue under a `zoneType` discriminator) was
 * rolled back; legacy `ZoneDefinition[]` records that may have leaked into
 * `state.roomMap.zones` on dev branches are DROPPED with a single
 * `console.warn` line so the operator can audit the loss. See
 * `.planning/RFCs/v1.5-w4-f-zone-unification.md` "Direction reversal" for
 * the full rationale.
 *
 * The pure helper `migrateLegacyHueZone` (in
 * `shared/contracts/roomMap.ts`) does the per-record Hue conversion and
 * returns `null` on corrupt inputs; this shim filters those nulls so the
 * migrated state never carries half-formed zones.
 */

import {
  migrateLegacyHueZone,
  type HueZone,
  type LegacyHueZone,
} from "../../shared/contracts/roomMap";
import {
  SHELL_STATE_SCHEMA_VERSION,
  type ShellState,
} from "../../shared/contracts/shell";

// ---------------------------------------------------------------------------
// 1 → 2 — fold legacy `hueZones` into `zones: HueZone[]`, drop logical leftovers
// ---------------------------------------------------------------------------

/**
 * Apply the `schemaVersion 1 → 2` zone-unification migration to a single
 * `ShellState` snapshot. Pure function — does not touch plugin-store, does
 * not produce side effects beyond `console.warn` calls (per-record corrupt
 * gates from `migrateLegacyHueZone`, plus a single aggregate warn when
 * dropping legacy logical zones).
 *
 * Behaviour (post-W4-F2 reversal):
 * - `state.schemaVersion === undefined` is treated as `1` (legacy
 *   pre-v1.5 shape, which lacks the field but carries the same on-disk
 *   layout as v1.5 schema 1).
 * - `state.schemaVersion >= 2` returns the input unchanged (idempotent —
 *   safe to call on every load).
 * - `state.schemaVersion === 1` produces a NEW state object with:
 *   - `roomMap.zones: HueZone[]` rebuilt from
 *     `roomMap.hueZones[]` (legacy `LegacyHueZone[]`) via
 *     `migrateLegacyHueZone`, plus any pre-existing entries on
 *     `roomMap.zones` that already carry a Hue shape (idempotent re-run
 *     guard).
 *   - Legacy `ZoneDefinition` records found on `roomMap.zones` (the brief
 *     W4-F unification dev-branch shape) are DROPPED with a single
 *     aggregate `console.warn` line listing the count.
 *   - `roomMap.hueZones` deleted.
 *   - `schemaVersion` set to `SHELL_STATE_SCHEMA_VERSION` (2).
 * - `state.roomMap === undefined` (fresh user) ⇒ no `roomMap` mutation;
 *   only the `schemaVersion` bump is applied.
 *
 * Errors during conversion are swallowed (the warn log is the trail) so a
 * single corrupt persisted record cannot brick the load path.
 */
export function migrateShellState(state: ShellState): ShellState {
  const currentVersion = state.schemaVersion ?? 1;
  if (currentVersion >= SHELL_STATE_SCHEMA_VERSION) {
    return state;
  }

  let next = state;

  // 1 → 2: fold legacy hueZones into zones:HueZone[], drop logical leftovers
  if (currentVersion < 2) {
    next = migrateV1ToV2(next);
  }

  return next;
}

/**
 * Internal — fold legacy `roomMap.hueZones` (`LegacyHueZone[]`) into
 * `roomMap.zones: HueZone[]` and drop any pre-existing `ZoneDefinition`
 * entries (brief W4-F unification dev-branch shape) with a single
 * aggregate warn.
 *
 * The idempotent re-run guard inspects each entry of the legacy `zones[]`
 * slot: a record that already carries a Hue shape (entertainmentAreaId +
 * finite center/scale) is preserved as-is; a record matching the legacy
 * `ZoneDefinition` shape (no entertainmentAreaId, optional `region`,
 * optional `zoneType: "logical"`) is counted and dropped.
 */
function migrateV1ToV2(state: ShellState): ShellState {
  const room = state.roomMap;

  if (!room) {
    // Fresh user without a persisted room map — only bump the schema.
    return { ...state, schemaVersion: 2 };
  }

  const existingZonesRaw = (room.zones ?? []) as unknown as Array<
    Record<string, unknown>
  >;
  const legacyHueZonesRaw = (room.hueZones ?? []) as LegacyHueZone[];

  const preservedHueZones: HueZone[] = [];
  let droppedLogicalCount = 0;

  for (const candidate of existingZonesRaw) {
    if (isHueShapedRecord(candidate)) {
      // Already-canonical (or already-migrated) Hue zone — strip any
      // `zoneType` field left over from the brief W4-F unification.
      const { zoneType: _drop, region: _drop2, ...cleaned } = candidate as Record<
        string,
        unknown
      > & { zoneType?: unknown; region?: unknown };
      void _drop;
      void _drop2;
      preservedHueZones.push(cleaned as unknown as HueZone);
      continue;
    }
    // Anything else (legacy `ZoneDefinition`, half-baked dev-branch record)
    // is dropped from the migrated state.
    droppedLogicalCount += 1;
  }

  if (droppedLogicalCount > 0) {
    console.warn(
      `[LumaSync] migration: dropping unsupported logical zones (count: ${droppedLogicalCount})`,
      "— logical zone concept removed in v1.5 W4-F2 (see RFC direction reversal)",
    );
  }

  const convertedHueZones: HueZone[] = [];
  for (const legacy of legacyHueZonesRaw) {
    const converted = migrateLegacyHueZone(legacy);
    if (converted) convertedHueZones.push(converted);
  }

  const mergedZones: HueZone[] = [...preservedHueZones, ...convertedHueZones];

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

/**
 * Internal — true when a persisted record on `roomMap.zones` carries a
 * Hue zone shape (string `entertainmentAreaId`, finite center/scale).
 * Used by the idempotent re-run guard so a v2-on-disk state survives a
 * second migration call without losing valid Hue zones, and so a brief
 * W4-F-era record carrying `zoneType: "hue"` is treated as Hue-shaped
 * after the discriminator is stripped.
 */
function isHueShapedRecord(record: Record<string, unknown>): boolean {
  if (typeof record !== "object" || record === null) return false;

  const ea = record["entertainmentAreaId"];
  if (typeof ea !== "string" || ea.length === 0) return false;

  for (const key of ["centerX", "centerY", "centerZ", "scaleX", "scaleY", "scaleZ"]) {
    const value = record[key];
    if (typeof value !== "number" || !Number.isFinite(value)) return false;
  }

  if (!Array.isArray(record["channelIndices"])) return false;
  if (typeof record["id"] !== "string" || (record["id"] as string).length === 0)
    return false;
  if (typeof record["name"] !== "string" || (record["name"] as string).length === 0)
    return false;

  return true;
}
