---
phase: 15-fault-recovery-and-diagnostics
plan: 01
subsystem: hue
tags: [hue, telemetry, contracts, i18n, fault-codes, typescript]

requires:
  - phase: 10-hue-stream-lifecycle
    provides: HueRuntimeStatus, deriveFamilyActionHints, hueRuntimeStatusCard

provides:
  - HUE_FAULT_CODES const with 13 structured fault codes in 4 families (NET/AUTH/STR/CFG)
  - HueFaultCode type alias
  - Extended deriveFamilyActionHints routing for all 7 code families
  - HueTelemetrySnapshot and FullTelemetrySnapshot interfaces
  - getFullTelemetrySnapshot and mapFullTelemetrySnapshot in telemetryApi
  - EN/TR i18n keys for all 13 fault codes, telemetry.hue section, and runtime status card copy

affects:
  - 15-02-PLAN: Rust backend must emit HUE_FAULT_CODES codes and FullTelemetrySnapshotDto shape
  - 15-03-PLAN: UI components consume HueTelemetrySnapshot and fault i18n keys

tech-stack:
  added: []
  patterns:
    - "HUE-FAMILY-NN structured fault code naming convention (prefix-based family routing)"
    - "FullTelemetrySnapshot wraps USB and Hue telemetry with nullable Hue field"
    - "deriveFamilyActionHints exported for direct unit testing"

key-files:
  created:
    - (extended) src/features/device/hueRuntimeStatusCard.test.ts
  modified:
    - src/shared/contracts/hue.ts
    - src/features/device/hueRuntimeStatusCard.ts
    - src/features/telemetry/model/contracts.ts
    - src/features/telemetry/telemetryApi.ts
    - src/locales/en/common.json
    - src/locales/tr/common.json

key-decisions:
  - "HUE-FAMILY-NN codes take routing priority over legacy TRANSIENT_/AUTH_INVALID_/CONFIG_NOT_READY_ prefixes in deriveFamilyActionHints"
  - "getRuntimeTelemetrySnapshot deprecated in favor of getFullTelemetrySnapshot; legacy function kept for backward compatibility with existing TelemetrySection.tsx"
  - "deriveFamilyActionHints exported (was private) to enable direct unit testing without indirection"

patterns-established:
  - "HUE-NET-xx: reconnect hint; HUE-AUTH-xx: repair hint; HUE-STR-xx: retry+adjust_area; HUE-CFG-xx: revalidate+adjust_area"
  - "FullTelemetrySnapshot.hue is nullable (null when Hue is not configured/running)"

requirements-completed: [HDR-01, HDR-02]

duration: 4min
completed: 2026-03-31
---

# Phase 15 Plan 01: Fault Recovery and Diagnostics — Contract Layer Summary

**HUE_FAULT_CODES taxonomy with 13 structured codes across 4 families, FullTelemetrySnapshot with Hue health signals, extended deriveFamilyActionHints routing, and complete EN/TR i18n parity for all new fault/telemetry copy**

## Performance

- **Duration:** 4 min
- **Started:** 2026-03-31T10:01:20Z
- **Completed:** 2026-03-31T10:05:05Z
- **Tasks:** 2
- **Files modified:** 6

## Accomplishments

- Added `HUE_FAULT_CODES` const object with 13 codes spanning NET (x4), AUTH (x3), STR (x4), CFG (x2) families to `hue.ts`
- Extended `deriveFamilyActionHints` with 4 new prefix checks (HUE-NET/AUTH/STR/CFG) that take priority over existing legacy checks; exported function for direct testing
- Added `HueTelemetrySnapshot` (11 fields) and `FullTelemetrySnapshot` interfaces; added `getFullTelemetrySnapshot` and `mapFullTelemetrySnapshot` to telemetryApi
- Added complete EN/TR i18n keys: `telemetry.hue` (12 keys each), `device.hue.runtime.faults` (13 fault entries each), and runtime card copy keys (6 keys each)
- Extended `hueRuntimeStatusCard.test.ts` with 15 new test cases covering all 4 new fault families, regression for 3 existing families, and edge cases

## Task Commits

1. **Task 1: Add HUE_FAULT_CODES and extend deriveFamilyActionHints** - `7ddc955` (feat)
2. **Task 2: Extend telemetry contracts, update telemetryApi, add i18n keys** - `cb3fd9c` (feat)

## Files Created/Modified

- `src/shared/contracts/hue.ts` - Added HUE_FAULT_CODES const (13 codes, 4 families) and HueFaultCode type
- `src/features/device/hueRuntimeStatusCard.ts` - Exported deriveFamilyActionHints; added HUE-NET/AUTH/STR/CFG routing before legacy checks
- `src/features/device/hueRuntimeStatusCard.test.ts` - Extended with 15 new test cases for new fault families, regressions, and edge cases
- `src/features/telemetry/model/contracts.ts` - Added HueTelemetrySnapshot (11 fields) and FullTelemetrySnapshot interfaces
- `src/features/telemetry/telemetryApi.ts` - Added FullTelemetrySnapshotDto, mapFullTelemetrySnapshot, getFullTelemetrySnapshot; deprecated getRuntimeTelemetrySnapshot
- `src/locales/en/common.json` - Added telemetry.hue section, device.hue.runtime.faults (13 entries), and 6 runtime card copy keys
- `src/locales/tr/common.json` - Same structure as EN with Turkish translations

## Decisions Made

- New `HUE-FAMILY-NN` fault codes take priority over legacy `TRANSIENT_/AUTH_INVALID_/CONFIG_NOT_READY_` prefix checks in `deriveFamilyActionHints` because they are more specific and structured.
- `getRuntimeTelemetrySnapshot` marked deprecated (not removed) to avoid breaking existing `TelemetrySection.tsx` which plan 15-03 will update.
- `deriveFamilyActionHints` exported from `hueRuntimeStatusCard.ts` to enable direct unit testing per plan instructions.

## Deviations from Plan

None — plan executed exactly as written.

## Issues Encountered

None.

## Known Stubs

None — this plan is contract/type layer only; no data flow to UI rendering.

## Next Phase Readiness

- Plan 15-02 (Rust backend) can now implement `get_runtime_telemetry` to return `FullTelemetrySnapshotDto` shape and emit `HUE_FAULT_CODES` string values
- Plan 15-03 (UI) can consume `HueTelemetrySnapshot`, fault i18n keys at `device.hue.runtime.faults.HUE-*`, and `telemetry.hue.*` keys

## Self-Check: PASSED

- `src/shared/contracts/hue.ts` — FOUND
- `src/features/device/hueRuntimeStatusCard.ts` — FOUND
- `src/features/device/hueRuntimeStatusCard.test.ts` — FOUND
- `src/features/telemetry/model/contracts.ts` — FOUND
- `src/features/telemetry/telemetryApi.ts` — FOUND
- `15-01-SUMMARY.md` — FOUND
- Commit `7ddc955` — FOUND
- Commit `cb3fd9c` — FOUND

---
*Phase: 15-fault-recovery-and-diagnostics*
*Completed: 2026-03-31*
