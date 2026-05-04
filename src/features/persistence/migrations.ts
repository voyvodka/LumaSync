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
 *
 * v1.5 (post-W4-F2) `2 → 3` — the corner-anchored window geometry
 * (`windowX` / `windowY` / `windowWidth` / `windowHeight`) is replaced by
 * a mode-invariant center point (`windowCenterX` / `windowCenterY`). The
 * boot path always (re)opens the window at compact dimensions regardless
 * of the persisted `uiMode`, so persisting the top-left corner of a
 * 900×620 outer rect produces a visibly off-center 320×480 window after
 * restore. The 2 → 3 step derives the center from the legacy fields
 * (`centerX = windowX + round(windowWidth / 2)`) and strips the four
 * corner fields.
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
// Legacy ShellState shape — used by the v2 → v3 migration step to read the
// retired corner fields off untyped persisted state without resurrecting
// them on the canonical `ShellState` interface.
// ---------------------------------------------------------------------------

/**
 * Legacy fields that lived on `ShellState` at schemaVersion ≤ 2. They are
 * read once by the 2 → 3 migration step to derive the new
 * `windowCenterX/Y` pair, then stripped from the migrated state.
 *
 * Declared inline here (not exported) so `ShellState` itself stays clean —
 * no consumer outside the migration module should ever read these fields.
 */
type LegacyWindowGeometry = {
  windowX?: number | null;
  windowY?: number | null;
  windowWidth?: number | null;
  windowHeight?: number | null;
};

// ---------------------------------------------------------------------------
// Top-level dispatcher
// ---------------------------------------------------------------------------

/**
 * Apply every queued schema-version step to a single `ShellState`
 * snapshot. Pure function — does not touch plugin-store, does not produce
 * side effects beyond `console.warn` calls inside the per-step helpers.
 *
 * Behaviour:
 * - `state.schemaVersion === undefined` is treated as `1` (legacy
 *   pre-v1.5 shape, which lacks the field but carries the same on-disk
 *   layout as v1.5 schema 1).
 * - `state.schemaVersion >= SHELL_STATE_SCHEMA_VERSION` returns the input
 *   unchanged (idempotent — safe to call on every load).
 * - Otherwise each step (`1 → 2`, `2 → 3`, …) runs in order; later steps
 *   only run when the running version is still below their target.
 */
export function migrateShellState(state: ShellState): ShellState {
  const currentVersion = state.schemaVersion ?? 1;
  if (currentVersion >= SHELL_STATE_SCHEMA_VERSION) {
    return state;
  }

  let next = state;

  // 1 → 2: fold legacy hueZones into zones:HueZone[], drop logical leftovers
  if ((next.schemaVersion ?? 1) < 2) {
    next = migrateV1ToV2(next);
  }

  // 2 → 3: replace corner+size geometry with mode-invariant center point
  if ((next.schemaVersion ?? 1) < 3) {
    next = migrateV2ToV3(next);
  }

  return next;
}

// ---------------------------------------------------------------------------
// 1 → 2 — fold legacy `hueZones` into `zones: HueZone[]`, drop logical leftovers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// 2 → 3 — replace corner+size window geometry with a mode-invariant center
// ---------------------------------------------------------------------------

/**
 * Internal — convert the retired corner-anchored geometry
 * (`windowX` / `windowY` / `windowWidth` / `windowHeight`) into the new
 * mode-invariant center pair (`windowCenterX` / `windowCenterY`) and
 * strip the four legacy fields from the migrated state.
 *
 * Conversion rule (legacy width/height was the inner content size, since
 * `getInnerSize()` produced the persisted dimensions in the corner-era
 * code path):
 *
 *     centerX = windowX + round(windowWidth / 2)
 *     centerY = windowY + round(windowHeight / 2)
 *
 * Bias caveat — on macOS the title bar adds ~28px of outer height that is
 * NOT captured in the persisted inner `windowWidth/Height`. The derived
 * center therefore sits ~14px above the user's perceived window center
 * for a one-shot legacy migration. Acceptable: the next persist after
 * any window move/resize overwrites the center using the *outer* size in
 * the rewritten `persistWindowState` path, so the bias self-corrects on
 * first interaction. Documenting here so a future maintainer doesn't
 * "fix" the migration by reaching for the chrome height (which is
 * platform-dependent and not knowable from persisted state alone).
 *
 * Defensive cases:
 * - All four legacy fields `null`/absent ⇒ both center fields are `null`
 *   (the user never moved the window away from OS default placement).
 * - Any of the four legacy fields `null` ⇒ both center fields are `null`
 *   (we do not silently substitute defaults; an incomplete corner record
 *   means the on-disk state is untrustworthy for derivation).
 * - Non-finite (`NaN` / `Infinity`) values ⇒ both center fields are
 *   `null` (same reasoning — corrupt input degrades to "no opinion").
 */
function migrateV2ToV3(state: ShellState): ShellState {
  const legacy = state as unknown as ShellState & LegacyWindowGeometry;

  const x = legacy.windowX;
  const y = legacy.windowY;
  const w = legacy.windowWidth;
  const h = legacy.windowHeight;

  const allFinite =
    typeof x === "number" &&
    Number.isFinite(x) &&
    typeof y === "number" &&
    Number.isFinite(y) &&
    typeof w === "number" &&
    Number.isFinite(w) &&
    typeof h === "number" &&
    Number.isFinite(h);

  let centerX: number | null = null;
  let centerY: number | null = null;
  if (allFinite) {
    centerX = x + Math.round(w / 2);
    centerY = y + Math.round(h / 2);
  }

  // Structurally drop the four legacy fields from the migrated state so a
  // round-tripped JSON snapshot does not carry stale geometry.
  const {
    windowX: _drop1,
    windowY: _drop2,
    windowWidth: _drop3,
    windowHeight: _drop4,
    ...rest
  } = legacy;
  void _drop1;
  void _drop2;
  void _drop3;
  void _drop4;

  return {
    ...rest,
    schemaVersion: 3,
    windowCenterX: centerX,
    windowCenterY: centerY,
  };
}
