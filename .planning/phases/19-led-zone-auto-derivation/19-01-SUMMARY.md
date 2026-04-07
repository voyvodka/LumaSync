---
phase: 19-led-zone-auto-derivation
plan: "01"
subsystem: room-map
tags: [zone-derivation, algorithm, tdd, i18n, test-stubs]
dependency_graph:
  requires:
    - src/shared/contracts/roomMap.ts
    - src/features/calibration/model/contracts.ts
  provides:
    - deriveZones pure algorithm (ZONE-01)
    - Wave 0 test stubs for ZONE-02, ZONE-03, ROOM-03
    - Phase 19 i18n keys (en + tr)
  affects:
    - src/features/settings/sections/room-map/
tech_stack:
  added: []
  patterns:
    - TDD (RED/GREEN/REFACTOR)
    - Pure function algorithm (no side effects, no React deps)
    - pointToSegmentDistance helper for closest-edge assignment
    - Proportional LED distribution with last-segment rounding correction
key_files:
  created:
    - src/features/settings/sections/room-map/deriveZones.ts
    - src/features/settings/sections/room-map/deriveZones.test.ts
    - src/features/settings/sections/room-map/ZoneDeriveOverlay.test.tsx
    - src/features/settings/sections/room-map/ZoneListPanel.test.tsx
  modified:
    - src/locales/en/common.json
    - src/locales/tr/common.json
decisions:
  - "@vitest-environment node annotation required for pure TS files and todo-only TSX stubs to avoid jsdom/ESM incompatibility with @asamuzakjp/css-color"
  - "Left-edge test uses y=[0.47..0.53] (TV vertical midspan only) to avoid corner tie-breaking where top and left edges equidistant"
metrics:
  duration: "~4 minutes"
  completed_date: "2026-04-07"
  tasks_completed: 3
  tasks_total: 3
  files_created: 4
  files_modified: 2
---

# Phase 19 Plan 01: Zone Derivation Algorithm and Wave 0 Test Stubs Summary

**One-liner:** Pure `deriveZones()` function mapping USB strip geometry to proportional TV-edge LED zone assignments, with 13 passing unit tests, 14 Wave 0 stubs, and 15 i18n keys in EN/TR.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Create deriveZones pure algorithm with TDD | 8b33f91 | deriveZones.ts, deriveZones.test.ts |
| 2 | Create Wave 0 test stubs for ZONE-02, ZONE-03, ROOM-03 | 4c45fc4 | ZoneDeriveOverlay.test.tsx, ZoneListPanel.test.tsx |
| 3 | Add all Phase 19 i18n keys to en and tr locales | 715221b | en/common.json, tr/common.json |

## What Was Built

### deriveZones.ts — Pure Algorithm (ZONE-01)

Exports:
- `deriveZones(strip, tv): ZoneDeriveResult` — maps strip geometry to per-edge LED counts
- `pointToSegmentDistance(px, py, ax, ay, bx, by): number` — helper for closest-edge assignment
- `ZoneDeriveResult` interface — `{ counts: LedSegmentCounts, segments: DerivedSegment[] }`
- `DerivedSegment` interface — `{ edge, ledCount, lengthMeters }`

Algorithm: samples N points along strip → assigns each to nearest TV edge via `pointToSegmentDistance` → groups consecutive same-edge points into segments → distributes LEDs proportionally, last segment absorbs rounding remainder.

Degenerate guards: zero-length strip (< 0.01m epsilon), both endpoints inside TV bounding box.

### Test Coverage (13 tests passing)

- Top/bottom/left single-edge assignment
- L-shaped strip multi-edge proportional distribution
- Sum invariant (totalLeds always preserved, odd/even)
- Degenerate: zero-length, inside TV
- pointToSegmentDistance: on-segment, perpendicular, beyond-endpoint, zero-length segment

### Wave 0 Stubs (14 todo, all skipped)

- `ZoneDeriveOverlay.test.tsx`: 6 todos for ZONE-02/ZONE-03
- `ZoneListPanel.test.tsx`: 8 todos for ROOM-03

### i18n Keys (15 per locale)

Added `roomMap.zones` object in both `en/common.json` and `tr/common.json`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] @vitest-environment node annotation for test files**
- **Found during:** Task 1 (RED phase verification)
- **Issue:** jsdom environment (vitest default) causes `ERR_REQUIRE_ASYNC_MODULE` via `@asamuzakjp/css-color` ESM/CJS incompatibility. This is a pre-existing environment configuration issue.
- **Fix:** Added `@vitest-environment node` docblock annotation to `deriveZones.test.ts`, `ZoneDeriveOverlay.test.tsx`, and `ZoneListPanel.test.tsx`
- **Files modified:** All three new test files
- **Commit:** 8b33f91, 4c45fc4

**2. [Rule 1 - Bug] Left-edge test coordinate adjustment**
- **Found during:** Task 1 (GREEN phase — 1 of 13 tests failed)
- **Issue:** Strip at `x=0.5, y=[0.3..0.7]` had corner ambiguity: points at y<0.45 are equidistant from top and left edges (both reach the same TV corner point). With `EDGE_KEYS` in `[top, right, bottom, left]` order, top was selected first.
- **Fix:** Narrowed strip y-range to `[0.47..0.53]` — strictly within TV's vertical span — so every sample point is always strictly closer to the left edge than any other edge.
- **Files modified:** deriveZones.test.ts
- **Commit:** 8b33f91

## Known Stubs

None — no stub values flow to UI. Wave 0 test stubs are `it.todo()` placeholders, not UI components.

## Self-Check: PASSED
