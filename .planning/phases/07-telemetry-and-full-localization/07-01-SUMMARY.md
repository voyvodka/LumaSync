---
phase: 07-telemetry-and-full-localization
plan: "01"
subsystem: runtime
tags: [tauri, telemetry, contracts, rust, typescript]

# Dependency graph
requires:
  - phase: 06-runtime-quality-controls
    provides: RuntimeQualityController + RuntimeFrameSlot hot-loop integration in ambilight worker
provides:
  - Rust-owned runtime telemetry snapshot command for capture/send FPS and queue health
  - Shared frontend telemetry contracts for section id, command id, and DTO types
  - Tauri app registration for telemetry managed state and invoke surface
affects: [phase-07-plan-02-localization, phase-07-plan-03-telemetry-ui, settings-navigation]

# Tech tracking
tech-stack:
  added: []
  patterns: [runtime-owned-telemetry-snapshot, one-second-window-fps-aggregation, shared-contract-single-source]

key-files:
  created:
    - src/features/telemetry/model/contracts.ts
    - src-tauri/src/commands/runtime_telemetry.rs
    - .planning/phases/07-telemetry-and-full-localization/07-01-SUMMARY.md
  modified:
    - src/shared/contracts/shell.ts
    - src/shared/contracts/device.ts
    - src-tauri/src/commands/lighting_mode.rs
    - src-tauri/src/commands/runtime_quality.rs
    - src-tauri/src/lib.rs

key-decisions:
  - "Queue health is derived from latest-slot overwrite pressure bands (healthy/warning/critical), not raw queue length."
  - "Telemetry metrics are aggregated in a 1-second Rust window and exposed via pull command snapshots."
  - "Telemetry command/state contracts are appended to existing shared shell/device contracts for parity-safe frontend wiring."

patterns-established:
  - "Telemetry Snapshot Pattern: worker updates Rust-owned state, frontend reads via get_runtime_telemetry command."
  - "Latest-Slot Health Pattern: queue pressure uses slot overwrite ratio bands instead of depth counters."

requirements-completed: [QUAL-03]

# Metrics
duration: 5 min
completed: 2026-03-21
---

# Phase 7 Plan 01: Telemetry Snapshot Baseline Summary

**Runtime quality metrics now ship as a Rust-owned telemetry snapshot command with capture/send FPS plus queue-health semantics, while shared frontend contracts expose telemetry section and command identifiers.**

## Performance

- **Duration:** 5 min
- **Started:** 2026-03-21T14:47:32Z
- **Completed:** 2026-03-21T14:52:43Z
- **Tasks:** 2
- **Files modified:** 7

## Accomplishments
- Added telemetry section and command identifiers to shared shell/device contracts as single-source frontend constants.
- Created `src/features/telemetry/model/contracts.ts` for `RuntimeTelemetrySnapshot`, queue-health union, and display model typing.
- Implemented `runtime_telemetry.rs` with managed state, `get_runtime_telemetry` command, 1-second FPS aggregation window, and queue-health mapping.
- Wired ambilight worker loop and app bootstrap so runtime updates telemetry state and Tauri registers `get_runtime_telemetry` for frontend polling.

## Task Commits

Each task was committed atomically:

1. **Task 1: Telemetry contract ve navigation girisini tanimla** - `2eed590` (feat)
2. **Task 2: Rust runtime telemetry snapshot command'unu uygula** - `0a79d8a` (feat)

**Plan metadata:** pending

## Files Created/Modified
- `src/shared/contracts/shell.ts` - Added `SECTION_IDS.TELEMETRY` and sidebar order entry.
- `src/shared/contracts/device.ts` - Added `DEVICE_COMMANDS.GET_RUNTIME_TELEMETRY` contract id.
- `src/features/telemetry/model/contracts.ts` - Added frontend telemetry DTO and queue health contracts.
- `src-tauri/src/commands/runtime_telemetry.rs` - Added runtime telemetry state, snapshot command, aggregation, and tests.
- `src-tauri/src/commands/lighting_mode.rs` - Integrated telemetry aggregation updates into ambilight worker loop.
- `src-tauri/src/commands/runtime_quality.rs` - Updated frame slot push API to report overwrite pressure.
- `src-tauri/src/lib.rs` - Registered telemetry state and invoke handler command.

## Decisions Made
- Queue-health UX is categorical (`healthy`, `warning`, `critical`) based on latest-slot overwrite pressure.
- Snapshot command returns Rust-owned telemetry state with coded lock errors (`RUNTIME_TELEMETRY_STATE_LOCK_FAILED`) for deterministic failure handling.
- Frontend telemetry wiring continues contract-first approach by extending existing shared contract files append-only.

## Deviations from Plan

None - plan executed exactly as written.

## Authentication Gates

None.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- QUAL-03 backend telemetry command surface is complete and test-covered with `runtime_telemetry::tests`.
- Frontend telemetry polling/UI wiring (07-03) and remaining EN/TR localization parity hardening (07-02) can build on this baseline.
- Ready for `07-02-PLAN.md`.

---
*Phase: 07-telemetry-and-full-localization*
*Completed: 2026-03-21*

## Self-Check: PASSED

- FOUND: `.planning/phases/07-telemetry-and-full-localization/07-01-SUMMARY.md`
- FOUND: `2eed590`
- FOUND: `0a79d8a`
