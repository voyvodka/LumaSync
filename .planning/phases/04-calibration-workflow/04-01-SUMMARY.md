---
phase: 04-calibration-workflow
plan: 01
subsystem: calibration-model
tags: [calibration, templates, led-mapping, validation, vitest, typescript]

# Dependency graph
requires:
  - phase: 03-connection-resilience-and-health
    provides: Stable shell/device baseline and contract-first section ID pattern
provides:
  - Typed calibration domain contracts for segments, anchor, direction, and persisted config
  - Hardcoded monitor template catalog with apply/reset helpers and template-to-config conversion
  - Deterministic anchor+direction LED sequence builder and centralized validation rules
affects: [phase-04-plan-02, phase-04-plan-03, calibration-wizard, calibration-preview]

# Tech tracking
tech-stack:
  added: []
  patterns: [Contracts-first calibration model, single pure LED ordering engine, centralized validation guard]

key-files:
  created: []
  modified:
    - src/shared/contracts/shell.ts
    - src/features/calibration/model/contracts.ts
    - src/features/calibration/model/templates.ts
    - src/features/calibration/model/indexMapping.ts
    - src/features/calibration/model/validation.ts
    - src/features/calibration/model/templates.test.ts
    - src/features/calibration/model/indexMapping.test.ts
    - src/features/calibration/model/validation.test.ts

key-decisions:
  - "Canonical LED traversal order is top -> right -> bottomRight -> bottomLeft -> left before anchor/direction transforms."
  - "Validation treats bottomGapPx as visual-only and enforces totalLeds consistency strictly from segment counts."

patterns-established:
  - "Calibration templates are hardcoded domain objects converted via toLedCalibrationConfig before persistence."
  - "All sequence orientation behavior is derived from buildLedSequence; UI layers should not remap indices."

requirements-completed: [CAL-01, CAL-02, CAL-03]

# Metrics
duration: 4 min
completed: 2026-03-19
---

# Phase 04 Plan 01: Calibration Model Foundation Summary

**Calibration domain now ships with typed template presets, deterministic anchor/direction LED ordering, and centralized validation that blocks invalid segment/gap combinations before UI wiring.**

## Performance

- **Duration:** 4 min
- **Started:** 2026-03-19T18:14:34Z
- **Completed:** 2026-03-19T18:18:37Z
- **Tasks:** 2
- **Files modified:** 8

## Accomplishments
- Added RED tests for template apply/reset behavior, deterministic sequence generation, and validation error contracts.
- Implemented calibration contracts, 5-template catalog, apply/reset helpers, and template conversion with computed totals.
- Implemented deterministic sequence engine (anchor rotate + direction orientation) and centralized validation for counts/gap/total rules.
- Extended shell contracts with `SECTION_IDS.CALIBRATION`, ordered section registration, and persisted `ledCalibration` state field.

## Task Commits

Each task was committed atomically:

1. **Task 1: RED - calibration model davranis testlerini yaz** - `5faf29a` (test)
2. **Task 2: GREEN - contracts, templates, mapping ve validation implement et** - `21de9c3` (feat)

**Plan metadata:** `db9ce30` (docs: complete plan)

_Note: Bu TDD plani RED ve GREEN asamalarinda iki commit uretti._

## Files Created/Modified
- `src/features/calibration/model/contracts.ts` - Calibration domain tip kontratlari ve segment toplam helper'i.
- `src/features/calibration/model/templates.ts` - Hardcoded monitor template katalogu ve apply/reset donusum akisi.
- `src/features/calibration/model/indexMapping.ts` - Anchor + direction tabanli deterministik LED index siralama motoru.
- `src/features/calibration/model/validation.ts` - Segment count, gap ve total LED uyum kurallarinin merkezi validator'u.
- `src/features/calibration/model/templates.test.ts` - Template katalogu ve apply/reset davranis testleri.
- `src/features/calibration/model/indexMapping.test.ts` - Deterministik siralama, CW/CCW ters cevrim ve gap invariance testleri.
- `src/features/calibration/model/validation.test.ts` - Gecersiz sayi/gap/toplam kombinasyonlari icin hata kodu testleri.
- `src/shared/contracts/shell.ts` - Calibration section ID/order ve `ShellState.ledCalibration` kontrat genisletmesi.

## Decisions Made
- Canonical traversal tek bir model fonksiyonunda sabitlendi; sonraki wizard/preview katmanlari yalnizca `buildLedSequence` ciktisini tuketecek.
- `bottomGapPx` LED toplamindan bagimsiz tutuldu; boyut degisimi fiziksel sirayi etkilemiyor, sadece gorsel/yerlesim semantigi tasiyor.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] STATE.md parse formati state advance-plan komutunu engelledi**
- **Found during:** Plan closure (state update step)
- **Issue:** `state advance-plan` komutu `Current Plan` ve `Total Plans in Phase` alanlarini parse edemedi.
- **Fix:** `STATE.md` current-position alanina parse edilebilir alanlar eklendi ve komut yeniden calistirildi.
- **Files modified:** `.planning/STATE.md`
- **Verification:** `state advance-plan` ikinci denemede basarili dondu (`current_plan: 2`).
- **Committed in:** `db9ce30` (plan metadata commit)

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Sadece plan metadata/state ilerletme adimini etkiledi; kod teslim kapsaminda degisiklik yok.

## Issues Encountered
None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
Calibration model katmani testlerle sabitlendi ve Phase 04-02 overlay/wizard akisi icin dogrudan import edilebilir durumda.
No blockers identified for the next plan.

## Self-Check: PASSED
- Found summary file: `.planning/phases/04-calibration-workflow/04-01-SUMMARY.md`
- Found task commits: `5faf29a`, `21de9c3`

---
*Phase: 04-calibration-workflow*
*Completed: 2026-03-19*
