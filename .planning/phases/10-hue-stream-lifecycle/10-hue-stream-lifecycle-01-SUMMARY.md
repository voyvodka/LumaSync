---
phase: 10-hue-stream-lifecycle
plan: 01
subsystem: api
tags: [hue, tauri, rust, lifecycle, runtime]

# Dependency graph
requires:
  - phase: 09-hue-bridge-onboarding
    provides: Hue bridge credentials, area selection, and readiness command contracts
provides:
  - Hue runtime lifecycle contract surface for start/stop/status command flows
  - Rust single-owner Hue runtime state machine with strict gate, bounded reconnect, and deterministic stop semantics
  - Tauri invoke registration for Hue stream lifecycle commands
affects: [10-02, mode-controls, device-status, hue-recovery]

# Tech tracking
tech-stack:
  added: []
  patterns: [single-runtime-owner, backend-authoritative-start-gate, bounded-retry-backoff, deterministic-stop-cleanup]

key-files:
  created:
    - src-tauri/src/commands/hue_stream_lifecycle.rs
  modified:
    - src/shared/contracts/hue.ts
    - src/features/mode/model/contracts.test.ts
    - src-tauri/src/lib.rs
    - src-tauri/capabilities/default.json

key-decisions:
  - "Hue runtime lifecycle keeps explicit Idle/Starting/Running/Reconnecting/Stopping/Failed states as backend-owned source of truth."
  - "Strict start gate remains backend authoritative and returns CONFIG_NOT_READY_* outcomes instead of optimistic UI-only checks."
  - "Retry/backoff remains bounded and auth-invalid evidence is separated from transient recovery with explicit action hints."

patterns-established:
  - "Hue Runtime Owner: all start/reconnect/stop transitions pass through one locked owner state."
  - "Coded Lifecycle Status: command outcomes keep code/message/details with retry and action-hint metadata."

requirements-completed: [HUE-05, HUE-06, HUE-07]

# Metrics
duration: 6 min
completed: 2026-03-21
---

# Phase 10 Plan 1: Hue Stream Lifecycle Summary

**Hue stream lifecycle now has backend-owned runtime states, strict start gating, bounded reconnect semantics, and deterministic stop outcomes wired to Tauri invoke commands.**

## Performance

- **Duration:** 6 min
- **Started:** 2026-03-21T19:41:35Z
- **Completed:** 2026-03-21T19:48:29Z
- **Tasks:** 3
- **Files modified:** 5

## Accomplishments
- Extended `src/shared/contracts/hue.ts` with lifecycle command IDs, runtime states, coded status families, retry/action-hint metadata, and trigger-source fields.
- Added RED/GREEN contract tests in `src/features/mode/model/contracts.test.ts` validating lifecycle state exports and telemetry/status shape.
- Implemented `src-tauri/src/commands/hue_stream_lifecycle.rs` with single-owner runtime status model, strict gate handling, idempotent start behavior, bounded reconnect policy, auth-invalid repair escalation, and deterministic stop semantics.
- Registered Hue lifecycle command surface in `src-tauri/src/lib.rs` and updated capability metadata in `src-tauri/capabilities/default.json`.

## Task Commits

Each task was committed atomically:

1. **Task 1 (TDD RED): Hue lifecycle contracts testlerini yaz** - `ba91af4` (test)
2. **Task 1 (TDD GREEN): Hue lifecycle contractlarini implement et** - `78116d4` (feat)
3. **Task 2 (TDD RED): Hue runtime lifecycle behavior testlerini ekle** - `e5202ea` (test)
4. **Task 2 (TDD GREEN): HueRuntimeOwner state machine commandlarini implement et** - `72d073c` (feat)
5. **Task 3: Lifecycle commandlarini invoke yuzeyine kaydet** - `c73099e` (feat)

**Plan metadata:** pending

## Files Created/Modified
- `src/shared/contracts/hue.ts` - Lifecycle runtime state/status/action-hint and telemetry contracts.
- `src/features/mode/model/contracts.test.ts` - Contract-level RED/GREEN assertions for Hue lifecycle surface.
- `src-tauri/src/commands/hue_stream_lifecycle.rs` - Hue runtime owner lifecycle logic and unit tests.
- `src-tauri/src/lib.rs` - Module visibility, managed state wiring, and invoke command registration.
- `src-tauri/capabilities/default.json` - Capability description updated for lifecycle command surface.

## Decisions Made
- Strict gate failures return deterministic `CONFIG_NOT_READY_GATE_BLOCKED` outcomes with actionable hint fields instead of initiating runtime.
- Reconnect policy is bounded and transitions to `Failed` with `TRANSIENT_RETRY_EXHAUSTED` + retry hint after budget exhaustion.
- Auth-invalid evidence is escalated to `AUTH_INVALID_CREDENTIALS` with repair hint and never treated as transient reconnect.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Module registration was required to execute RED tests by filter**
- **Found during:** Task 2 (TDD RED)
- **Issue:** `cargo test ... hue_stream_lifecycle` did not discover lifecycle tests until the new command module was included in crate module graph.
- **Fix:** Added `pub mod hue_stream_lifecycle;` in `src-tauri/src/lib.rs` during RED stage so filtered tests execute as intended.
- **Files modified:** `src-tauri/src/lib.rs`
- **Verification:** `cargo test --manifest-path src-tauri/Cargo.toml hue_stream_lifecycle -- --nocapture`
- **Committed in:** `e5202ea`

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Required only for reliable TDD execution path; no scope creep.

## Issues Encountered

None.

## Authentication Gates

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Backend lifecycle surface (`start_hue_stream`, `stop_hue_stream`, `get_hue_stream_status`) is available for mode-control authority work in `10-02-PLAN.md`.
- Shared contracts now expose runtime states, retry metadata, and action hints for UI mapping in upcoming plans.

---
*Phase: 10-hue-stream-lifecycle*
*Completed: 2026-03-21*

## Self-Check: PASSED

- FOUND: `.planning/phases/10-hue-stream-lifecycle/10-hue-stream-lifecycle-01-SUMMARY.md`
- FOUND: `ba91af4`, `78116d4`, `e5202ea`, `72d073c`, `c73099e`
