---
phase: 04-calibration-workflow
plan: "06"
subsystem: calibration
tags: [calibration, led-mapping, test-pattern, overlay]
requires:
  - phase: 04-05
    provides: config-driven test pattern payload and flow config sync
provides:
  - Shared marker-index normalization helper for sequence consumers
  - Physical payload lookup and overlay marker preview now use the same sequence resolver
  - Orientation-aware mapping parity is asserted with regression tests
affects: [Phase 4 verification, Phase 5 core lighting modes]
tech-stack:
  added: []
  patterns:
    - shared sequence resolver for marker-driven LED mapping
    - TDD red-green commits for calibration parity fixes
key-files:
  created: []
  modified:
    - src/features/calibration/model/indexMapping.ts
    - src/features/calibration/state/testPatternFlow.ts
    - src/features/calibration/state/testPatternFlow.test.ts
    - src/features/calibration/ui/CalibrationOverlay.tsx
key-decisions:
  - "Introduced resolveLedSequenceItem in indexMapping as single marker normalization contract."
  - "CalibrationOverlay derives marker segment and segment order from one memoized buildLedSequence output to keep preview parity deterministic."
patterns-established:
  - "Mapping consumers (flow/presentation) resolve active LED/segment through shared helper instead of duplicating modulo logic."
requirements-completed: [CAL-01, CAL-02, CAL-03, CAL-04, UX-02]
duration: 1 min
completed: 2026-03-19
---

# Phase 4 Plan 6: Mapping-Order Parity Summary

**Test-pattern marker parity now uses a shared sequence resolver so physical LED payload and overlay segment preview stay aligned across start-anchor and direction changes.**

## Performance

- **Duration:** 1 min
- **Started:** 2026-03-20T01:21:39+03:00
- **Completed:** 2026-03-19T22:22:35Z
- **Tasks:** 1 (TDD with RED + GREEN commits)
- **Files modified:** 4

## Accomplishments
- Added RED-phase regression tests for shared marker lookup semantics and non-zero mapped payload checks.
- Implemented `resolveLedSequenceItem` and reused it in default test pattern flow hardware payload selection.
- Refactored overlay marker/segment derivation to consume one sequence source for preview label/order parity.

## Task Commits

Each task was committed atomically:

1. **Task 1 (RED): Mapping-order parity'yi model, flow ve preview katmaninda sabitle** - `8492aee` (test)
2. **Task 1 (GREEN): Mapping-order parity'yi model, flow ve preview katmaninda sabitle** - `4dd06b5` (feat)

**Plan metadata:** pending (added after state/docs update commit)

## Files Created/Modified
- `src/features/calibration/state/testPatternFlow.test.ts` - Added failing parity tests for shared marker-index lookup semantics.
- `src/features/calibration/model/indexMapping.ts` - Added shared sequence-item resolver and kept canonical physical index semantics intact.
- `src/features/calibration/state/testPatternFlow.ts` - Switched physical LED payload index resolution to shared sequence resolver.
- `src/features/calibration/ui/CalibrationOverlay.tsx` - Derived marker segment/order from one `buildLedSequence` source.

## Decisions Made
- Marker-index normalization is now centralized in model layer via `resolveLedSequenceItem` to avoid drift between UI and physical payload paths.
- Overlay preview now computes both active segment and segment pills from the same memoized sequence.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- CAL-04 parity gap items are code-closed for physical index semantics, marker-driven payload, and preview segment consistency.
- Ready for `04-07-PLAN.md` regression hardening and re-verification gate.

## Self-Check: PASSED
- FOUND: `.planning/phases/04-calibration-workflow/04-06-SUMMARY.md`
- FOUND: `8492aee`
- FOUND: `4dd06b5`
