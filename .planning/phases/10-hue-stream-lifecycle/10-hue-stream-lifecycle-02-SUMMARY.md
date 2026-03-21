---
phase: 10-hue-stream-lifecycle
plan: 02
subsystem: ui
tags: [hue, mode-control, dual-output, persistence, vitest]

# Dependency graph
requires:
  - phase: 10-01
    provides: Hue runtime lifecycle commands and coded status contract
provides:
  - Mode-control owned Hue/USB runtime planning with deterministic target arbitration
  - App-level Hue start/stop command wiring with coded gate and idempotent no-op handling
  - Persisted output target selection (USB/Hue/USB+Hue) restored across sessions
affects: [10-03, device-runtime-ux, output-target-routing]

# Tech tracking
tech-stack:
  added: []
  patterns: [target-scoped-runtime-planning, coded-gate-aware-start, persisted-output-target-set]

key-files:
  created:
    - src/features/mode/state/hueModeRuntimeFlow.ts
    - src/features/mode/state/hueModeRuntimeFlow.test.ts
  modified:
    - src/features/mode/modeApi.ts
    - src/App.tsx
    - src/shared/contracts/shell.ts
    - src/features/settings/sections/GeneralSection.tsx

key-decisions:
  - "Mode control keeps start authority and routes USB/Hue lifecycle commands through one target planner."
  - "Partial start is accepted; healthy targets continue even when one target returns a gate/runtime failure."
  - "Output target set is persisted as shell state (`lastOutputTargets`) and restored with USB-first fallback."

patterns-established:
  - "Dual-target Arbitration Pattern: resolve plan first, execute target commands, then merge per-target outcomes."
  - "Manual Stop Priority Pattern: user stop actions route by target and suppress reconnect continuation."

requirements-completed: [HUE-05, HUE-06]

# Metrics
duration: 7 min
completed: 2026-03-21
---

# Phase 10 Plan 02: Hue Stream Lifecycle Summary

**Mode controls now own Hue/USB start-stop authority with deterministic dual-target arbitration, coded partial-start handling, and persisted output target selection across sessions.**

## Performance

- **Duration:** 7 min
- **Started:** 2026-03-21T19:52:46Z
- **Completed:** 2026-03-21T20:00:02Z
- **Tasks:** 3
- **Files modified:** 11

## Accomplishments
- Added `hueModeRuntimeFlow` pure planner/merger to produce deterministic start-stop steps for USB, Hue, and dual target selections.
- Wired `App.tsx` + `modeApi.ts` with typed Hue lifecycle wrappers so mode controls can trigger Hue runtime starts/stops and consume coded backend outcomes.
- Added target selection controls to General settings and persisted `lastOutputTargets` in shell state with restore-on-bootstrap behavior.
- Expanded tests to cover dual-target partial start, idempotent hue start no-op handling, manual stop routing, and General target selector behavior.

## Task Commits

Each task was committed atomically:

1. **Task 1 (TDD RED): Mode-layer Hue runtime flow testlerini yaz** - `156771a` (test)
2. **Task 1 (TDD GREEN): Hue target arbitration plannerini implement et** - `7839875` (feat)
3. **Task 2 (TDD RED): App Hue lifecycle orchestration testlerini yaz** - `236904e` (test)
4. **Task 2 (TDD GREEN): Mode-control Hue lifecycle command entegrasyonunu tamamla** - `6be26d6` (feat)
5. **Task 3: Target set secimi ve shell persistence restore davranisini bagla** - `f2c9c7a` (feat)

**Plan metadata:** pending

## Files Created/Modified
- `src/features/mode/state/hueModeRuntimeFlow.ts` - Target-scoped runtime plan and result merge helpers.
- `src/features/mode/state/hueModeRuntimeFlow.test.ts` - Deterministic start plan, partial-start, and manual-stop priority tests.
- `src/features/mode/modeApi.ts` - Typed `startHue`/`stopHue` wrappers and Hue runtime command result shape.
- `src/App.tsx` - Mode-control runtime orchestration, target-plan execution, and persisted target restore/save.
- `src/features/settings/sections/GeneralSection.tsx` - USB/Hue/USB+Hue output target selector UI.
- `src/shared/contracts/shell.ts` - `lastOutputTargets` persistence contract extension.

## Decisions Made
- Start orchestration is planned per target (USB/Hue) and merged into a single runtime outcome so partial success is explicit and safe.
- Hue gate failures (`CONFIG_NOT_READY_*`) keep UI mode state stable instead of optimistic state flips.
- Manual stop actions route through selected active targets and do not trigger implicit reconnect continuation.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Active-target filtering prevented idempotent start behavior**
- **Found during:** Task 2 (TDD GREEN)
- **Issue:** Initial planner skipped already-active targets, so repeated Start could not surface backend `HUE_START_NOOP_ALREADY_ACTIVE` behavior.
- **Fix:** Updated start planning to execute selected targets deterministically each trigger and rely on backend coded no-op semantics.
- **Files modified:** `src/features/mode/state/hueModeRuntimeFlow.ts`
- **Verification:** `yarn vitest run src/features/mode/state/hueModeRuntimeFlow.test.ts src/App.test.tsx`
- **Committed in:** `6be26d6`

**2. [Rule 3 - Blocking] Settings/layout contracts required expansion for target selector wiring**
- **Found during:** Task 3
- **Issue:** `GeneralSection` target controls required prop, layout, i18n, and test updates not listed explicitly in task file list.
- **Fix:** Extended `SettingsLayout` pass-through props, added locale keys, and aligned tests to new selector contract.
- **Files modified:** `src/features/settings/SettingsLayout.tsx`, `src/locales/en/common.json`, `src/locales/tr/common.json`, `src/features/settings/sections/GeneralSection.test.tsx`, `src/App.test.tsx`
- **Verification:** `yarn vitest run src/features/settings/sections/GeneralSection.test.tsx` and `yarn vitest run src/App.test.tsx`
- **Committed in:** `f2c9c7a`

---

**Total deviations:** 2 auto-fixed (1 bug, 1 blocking)
**Impact on plan:** Deviations were required for correctness and compile-safe integration; no scope creep beyond plan objective.

## Authentication Gates

None.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Mode-control authority and target persistence are in place for Device-surface runtime observability work in `10-03`.
- Dual-output policy behavior (parallel start, partial success, target-based stop, manual priority) is covered by unit tests.

---
*Phase: 10-hue-stream-lifecycle*
*Completed: 2026-03-21*

## Self-Check: PASSED

- FOUND: `.planning/phases/10-hue-stream-lifecycle/10-hue-stream-lifecycle-02-SUMMARY.md`
- FOUND commits: `156771a`, `7839875`, `236904e`, `6be26d6`, `f2c9c7a`
