---
phase: 10-hue-stream-lifecycle
plan: 05
subsystem: ui
tags: [hue, runtime-status, device-surface, retry-pipeline, vitest]

# Dependency graph
requires:
  - phase: 10-hue-stream-lifecycle
    provides: Device runtime mapper + stale-readiness gate + shared stop direction from 10-03/10-04
provides:
  - Mode API runtime status wrapper for Hue lifecycle observability
  - useHueOnboarding runtime polling + target telemetry mapping + non-noop retry pipeline
  - DeviceSection stop action routed to shared Hue stop pipeline with device trigger source
affects: [phase-11-device-surface-integration, hue-recovery-ux, runtime-observability]

# Tech tracking
tech-stack:
  added: []
  patterns: [shared-hue-stop-pipeline, runtime-status-polling, target-scoped-retry-telemetry]

key-files:
  created:
    - src/features/device/useHueOnboarding.runtime.test.ts
  modified:
    - src/features/mode/modeApi.ts
    - src/features/mode/modeApi.test.ts
    - src/features/device/useHueOnboarding.ts
    - src/features/settings/sections/DeviceSection.tsx
    - src/features/settings/sections/DeviceSection.test.tsx
    - src/locales/en/common.json
    - src/locales/tr/common.json

key-decisions:
  - "Device surface stop path must always call stopHue with device_surface trigger to share a single stop pipeline."
  - "Runtime target retry on Hue uses explicit stop+start command chain with coded trigger source instead of no-op handlers."
  - "Runtime telemetry rows are derived from explicit status/telemetry fields, not free-text parsing."

patterns-established:
  - "Pattern: Device runtime polling uses lightweight interval and updates target rows from typed status payloads."
  - "Pattern: Retry metadata (remainingAttempts/nextAttemptMs) is rendered on per-target rows when available."

requirements-completed: [HUE-05, HUE-06, HUE-07]

# Metrics
duration: 9 min
completed: 2026-03-21
---

# Phase 10 Plan 05: Hue Stream Lifecycle Summary

**Device runtime gap closure now ships real Hue status polling, non-noop target retry commands, and shared device-surface stop routing through the same Hue lifecycle pipeline.**

## Performance

- **Duration:** 9 min
- **Started:** 2026-03-21T20:26:32Z
- **Completed:** 2026-03-21T20:36:27Z
- **Tasks:** 3
- **Files modified:** 8

## Accomplishments
- Added `getHueStreamStatus` wrapper to `modeApi` and locked trigger-source stop/start wrapper behavior with tests.
- Replaced `useHueOnboarding` runtime stubs (`null`/`[]`/no-op) with real polling, target-row telemetry derivation, and Hue retry command routing.
- Switched DeviceSection stop action to `stopHue(HUE_RUNTIME_TRIGGER_SOURCE.DEVICE_SURFACE)` and surfaced per-target retry status metadata.

## Task Commits

Each task was committed atomically:

1. **Task 1 (TDD RED): Mode API runtime wrapper tests** - `2ef5c13` (test)
2. **Task 1 (TDD GREEN): Mode API runtime wrapper implementation** - `a35e3a4` (feat)
3. **Task 2 (TDD RED): Hook runtime polling/retry tests** - `861e4a5` (test)
4. **Task 2 (TDD GREEN): Hook runtime polling/retry wiring** - `93a9129` (feat)
5. **Task 3 (TDD RED): DeviceSection stop/runtime row tests** - `9868cfb` (test)
6. **Task 3 (TDD GREEN): DeviceSection shared stop + runtime row UI** - `a9dcc92` (feat)

**Plan metadata:** pending

## Files Created/Modified
- `src/features/mode/modeApi.ts` - Added typed `getHueStreamStatus` command wrapper.
- `src/features/mode/modeApi.test.ts` - Added runtime status, device trigger stop, and start regression coverage.
- `src/features/device/useHueOnboarding.ts` - Added runtime polling, telemetry mapping, and non-noop retry pipeline.
- `src/features/device/useHueOnboarding.runtime.test.ts` - Added runtime polling, telemetry derivation, and retry pipeline tests.
- `src/features/settings/sections/DeviceSection.tsx` - Routed stop action to shared Hue stop pipeline and rendered retry metadata.
- `src/features/settings/sections/DeviceSection.test.tsx` - Updated assertions for shared stop routing and runtime retry visibility.

## Decisions Made
- Device panel stop action now always uses Hue shared stop command path with `device_surface` trigger source.
- Runtime retry behavior avoids free-text heuristics and uses explicit command pipeline + typed status fields.
- Runtime target rows display retry telemetry only when backend fields exist.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Device runtime retry metadata required locale key parity update**
- **Found during:** Task 3 (DeviceSection runtime row rendering)
- **Issue:** New retry status copy key required EN/TR locale entries to avoid missing-text fallback.
- **Fix:** Added `device.hue.runtime.retryStatus` to both locale files.
- **Files modified:** `src/locales/en/common.json`, `src/locales/tr/common.json`
- **Verification:** `yarn vitest run src/features/settings/sections/DeviceSection.test.tsx`
- **Committed in:** `a9dcc92`

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Deviation stayed within plan scope and was required for complete runtime row UX parity.

## Authentication Gates

None.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Device runtime panel now receives real status feed and actionable per-target retry controls.
- Shared stop pipeline is aligned between mode controls and device surface for HUE-07 consistency.

---
*Phase: 10-hue-stream-lifecycle*
*Completed: 2026-03-21*

## Self-Check: PASSED

- FOUND: `.planning/phases/10-hue-stream-lifecycle/10-hue-stream-lifecycle-05-SUMMARY.md`
- FOUND commits: `2ef5c13`, `a35e3a4`, `861e4a5`, `93a9129`, `9868cfb`, `a9dcc92`
