---
phase: 20-device-ux-polish-and-channel-write-back
plan: 01
subsystem: ui
tags: [react, i18n, hue, device-ux, testing, happy-dom]

# Dependency graph
requires:
  - phase: 15-fault-recovery-and-diagnostics
    provides: hueRuntimeStatusCard.ts and buildHueRuntimeStatusCard utility
  - phase: 18-hue-standalone-mode
    provides: useHueOnboarding with canStartHue, runtimeStatus, selectedArea, selectedBridge
provides:
  - HueReadySummaryCard inline component in DeviceSection (HUX-01)
  - device.hue.summary i18n keys (idle/streaming/error) in EN and TR locales
  - 3 unit tests for HueReadySummaryCard visibility and streaming state
affects: [20-device-ux-polish-and-channel-write-back]

# Tech tracking
tech-stack:
  added: [happy-dom (test environment, replaces jsdom for Node.js v25 compat)]
  patterns: [inline function component inside DeviceSection for co-located UX sub-cards]

key-files:
  created: []
  modified:
    - src/features/settings/sections/DeviceSection.tsx
    - src/features/settings/sections/DeviceSection.test.tsx
    - src/locales/en/common.json
    - src/locales/tr/common.json
    - vitest.config.ts
    - package.json

key-decisions:
  - "HueReadySummaryCard defined as inline function component inside DeviceSection — avoids prop drilling for canStartHue, selectedArea, selectedBridge, setHueExpandedStep"
  - "Vitest environment migrated from jsdom to happy-dom — jsdom v29 + Node.js v25 ESM incompatibility blocks all tsx render tests project-wide"
  - "Card click opens 'ready' accordion step (setHueExpandedStep('ready')) when accordion is closed, and closes it (null) when open"

patterns-established:
  - "Hue status dot colors: variant success=bg-emerald-500 animate-pulse, error=bg-rose-500, info=bg-slate-300 dark:bg-zinc-600"
  - "Summary card shell: rounded-xl border border-slate-200/80 bg-white/90 px-5 py-4 dark:border-zinc-800 dark:bg-zinc-900/80"

requirements-completed: [HUX-01]

# Metrics
duration: 20min
completed: 2026-04-08
---

# Phase 20 Plan 01: Hue Ready Summary Card Summary

**Read-only Hue stream status card in DeviceSection showing stream state dot, area name, bridge IP — visible only when canStartHue=true (HUX-01)**

## Performance

- **Duration:** ~20 min
- **Started:** 2026-04-08T08:25:00Z
- **Completed:** 2026-04-08T08:45:39Z
- **Tasks:** 1
- **Files modified:** 6 (+ package.json, yarn.lock)

## Accomplishments

- Added `device.hue.summary` i18n keys (idle/streaming/error) to both EN and TR locale files with EN/TR parity maintained
- Implemented `HueReadySummaryCard` inline component in DeviceSection that shows colored status dot, area name, bridge IP, and stream state label
- Card only renders when `canStartHue === true` and clicking it toggles the wizard accordion
- Added 3 test cases covering: card visible when ready, card hidden when not ready, streaming dot color
- Fixed project-wide render test breakage by migrating vitest environment from jsdom to happy-dom (Node.js v25/jsdom ESM incompatibility)

## Task Commits

1. **Task 1: Add i18n keys and HueReadySummaryCard with tests** - `885ed3b` (feat)

**Plan metadata:** (pending final docs commit)

## Files Created/Modified

- `src/features/settings/sections/DeviceSection.tsx` - Added HueReadySummaryCard function component and render call above wizard accordion
- `src/features/settings/sections/DeviceSection.test.tsx` - Added 3 HueReadySummaryCard test cases in new describe block
- `src/locales/en/common.json` - Added `device.hue.summary.{idle,streaming,error}` keys
- `src/locales/tr/common.json` - Added `device.hue.summary.{idle,streaming,error}` keys (TR translations)
- `vitest.config.ts` - Changed environment from jsdom to happy-dom
- `package.json` + `yarn.lock` - Added happy-dom devDependency

## Decisions Made

- `HueReadySummaryCard` is an inline function component inside `DeviceSection` — shares closure over all hook state without additional prop drilling.
- Accordion toggle behavior: card click sets `hueExpandedStep` to `"ready"` when closed, or `null` when open.
- Vitest environment changed to `happy-dom` project-wide (not per-file) to fix pre-existing Node.js v25 + jsdom ESM incompatibility.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Migrated vitest environment from jsdom to happy-dom**

- **Found during:** Task 1 (test verification)
- **Issue:** jsdom v29 + Node.js v25 throws `ERR_REQUIRE_ASYNC_MODULE` — all `.test.tsx` render tests fail to start
- **Fix:** Added `happy-dom` devDependency, changed `vitest.config.ts` environment from `"jsdom"` to `"happy-dom"`
- **Files modified:** `vitest.config.ts`, `package.json`, `yarn.lock`
- **Verification:** All 7 DeviceSection tests pass, all existing tests unaffected
- **Committed in:** `885ed3b` (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Essential — without this fix the plan's acceptance criterion (`yarn vitest run` exits 0) could not be met. No scope creep.

## Issues Encountered

- `getByText("Living Room")` in first test found multiple DOM nodes (wizard accordion also showed area name). Fixed by asserting on the i18n label key `device.hue.summary.idle` which is unique to the summary card.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- HUX-01 complete. DeviceSection now shows Hue stream health at a glance without expanding wizard.
- Phase 20 Plan 02 (output target switcher, HUX-02) can proceed.

---
*Phase: 20-device-ux-polish-and-channel-write-back*
*Completed: 2026-04-08*

## Self-Check: PASSED

- FOUND: DeviceSection.tsx
- FOUND: en/common.json (device.hue.summary.idle = "Ready, not streaming")
- FOUND: tr/common.json (device.hue.summary.idle = "Bağlı, akış yok")
- FOUND: DeviceSection.test.tsx (3 HueReadySummaryCard tests)
- FOUND: 20-01-SUMMARY.md
- FOUND commit: 885ed3b
