---
phase: 10-hue-stream-lifecycle
plan: 03
subsystem: ui
tags: [hue, runtime, device-section, lifecycle, i18n]
requires:
  - phase: 10-hue-stream-lifecycle
    provides: Hue runtime lifecycle contracts and mode-control authority from Plans 10-01 and 10-02
provides:
  - Runtime status mapper for deterministic lifecycle card rendering
  - DeviceSection stale-readiness gate and shared stop pipeline trigger
  - EN/TR runtime lifecycle copy parity for action and status hints
affects: [device-ui, hue-runtime-recovery, i18n-parity]
tech-stack:
  added: []
  patterns: [code-family action hint mapping, target-scoped runtime controls, stale-readiness start gate]
key-files:
  created:
    - src/features/device/hueRuntimeStatusCard.ts
    - src/features/device/hueRuntimeStatusCard.test.ts
    - src/features/settings/sections/DeviceSection.test.tsx
  modified:
    - src/features/device/useHueOnboarding.ts
    - src/features/settings/sections/DeviceSection.tsx
    - src/shared/contracts/hue.ts
    - src/locales/en/common.json
    - src/locales/tr/common.json
key-decisions:
  - "Runtime status mapping derives CTA hints only from explicit code-family or actionHint fields."
  - "Device Start remains blocked when credential validation is unknown/in-flight or readiness is stale."
  - "Device-surface Stop routes to shared mode stop pipeline instead of local ad-hoc flow."
patterns-established:
  - "Pattern: Runtime card model exposes retry and trigger-source metadata through deterministic keys."
  - "Pattern: Recovering target controls are constrained while healthy targets remain operable."
requirements-completed: [HUE-06, HUE-07]
duration: 8 min
completed: 2026-03-21
---

# Phase 10 Plan 3: Hue Stream Lifecycle Summary

**Device yüzeyinde Hue runtime görünürlüğü, stale-readiness gate kontrolü ve shared stop/recovery UX akışı deterministic model ve EN/TR parity kopyalarıyla tamamlandı.**

## Performance

- **Duration:** 8 min
- **Started:** 2026-03-21T19:52:53Z
- **Completed:** 2026-03-21T20:01:13Z
- **Tasks:** 3
- **Files modified:** 8

## Accomplishments
- `buildHueRuntimeStatusCard` ile lifecycle code/status -> UI model dönüşümü (retry progress, trigger-source, action hints) eklendi.
- DeviceSection, validating/unknown credential ve stale readiness durumlarında Start gate'i kapatacak şekilde güncellendi; Stop eylemi shared pipeline'a bağlandı.
- Target-scoped runtime kontrol satırlarıyla recovering target kısıtı + healthy target operasyon kabiliyeti aynı panelde görünür hale getirildi.
- `device.hue.runtime` EN/TR kopyaları parity korunarak lifecycle, checklist, action ve target key hiyerarşisine tamamlandı.

## Task Commits

Each task was committed atomically:

1. **Task 1 (TDD RED): Runtime mapper failing tests** - `82e25e4` (test)
2. **Task 1 (TDD GREEN): Runtime mapper implementation** - `f7e52f1` (feat)
3. **Task 2 (TDD RED): DeviceSection lifecycle failing tests** - `28852bc` (test)
4. **Task 2 (TDD GREEN): DeviceSection + onboarding gate/stop updates** - `af51506` (feat)
5. **Task 3: Runtime EN/TR parity copy updates** - `d4dca62` (feat)

## Files Created/Modified
- `src/features/device/hueRuntimeStatusCard.ts` - runtime lifecycle status mapper (state/code/action/retry/trigger-source)
- `src/features/device/hueRuntimeStatusCard.test.ts` - reconnect/auth-invalid/config-not-ready/trigger-source behavior tests
- `src/features/settings/sections/DeviceSection.test.tsx` - Start gate, shared stop pipeline, target-scoped control tests
- `src/features/device/useHueOnboarding.ts` - stale-readiness tracking + unknown credential gating + runtime control surface shape
- `src/features/settings/sections/DeviceSection.tsx` - runtime checklist, shared stop trigger, target retry controls, runtime card rendering
- `src/shared/contracts/hue.ts` - `unknown` credential state extension
- `src/locales/en/common.json` - runtime lifecycle EN copy refinements
- `src/locales/tr/common.json` - runtime lifecycle TR copy refinements

## Decisions Made
- CTA belirleme yalnız explicit status code-family (`AUTH_INVALID_*`, `CONFIG_NOT_READY_*`, `TRANSIENT_*`) ve `actionHint` alanından türetildi; message parsing yapılmadı.
- Start gate için `canStartHue` hesabına stale-readiness ve validating credential koşulları zorunlu eklendi.
- Device panelde Stop eylemi tek pipeline disiplini için `stopLighting` üstünden route edildi.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] Added explicit `unknown` credential state for validation-in-flight gate safety**
- **Found during:** Task 2 (DeviceSection + onboarding controller update)
- **Issue:** Existing credential state model had only `valid|needs_repair`, so validating/unknown gate state could not be represented explicitly.
- **Fix:** Extended `HUE_CREDENTIAL_STATUS` with `unknown` and used it during credential validation flow.
- **Files modified:** `src/shared/contracts/hue.ts`, `src/features/device/useHueOnboarding.ts`
- **Verification:** `yarn vitest run src/features/settings/sections/DeviceSection.test.tsx`
- **Committed in:** `af51506`

---

**Total deviations:** 1 auto-fixed (1 missing critical)
**Impact on plan:** Deviation was required to satisfy locked start-gate semantics; no scope creep.

## Issues Encountered
- Task 3 parity verify command initially failed due shell interpolation of template literals in inline Node execution; command was rerun with shell-safe quoting and passed (`PARITY_OK`).

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- Device surface now exposes runtime lifecycle/recovery cues aligned with Phase 10 decision matrix.
- Shared stop pipeline visibility is in place; phase is ready for downstream diagnostics/recovery expansion.

---
*Phase: 10-hue-stream-lifecycle*
*Completed: 2026-03-21*

## Self-Check: PASSED
