---
phase: 01-app-shell-and-baseline-defaults
plan: "02"
subsystem: i18n
tags: [i18next, react-i18next, typescript, vitest, localization, english, turkish]

# Dependency graph
requires:
  - phase: 01-app-shell-and-baseline-defaults
    provides: LanguageSection slot (Plan 03), shellStore.ts persistence API, App.tsx bootstrap point

provides:
  - languagePolicy.ts: deterministic first-launch language resolution (I18N-02 compliant)
  - i18n.ts: i18next runtime with EN/TR resources and English fallback
  - providers.tsx: I18nextProvider composition for app tree
  - LanguageSection.tsx: functional language selector with immediate apply + persistence
  - locales/en/common.json + locales/tr/common.json: Phase 1 baseline translation strings
  - default-language.test.ts: automated proof for first-launch English and persisted override
  - vitest.config.ts: Vitest unit test configuration
  - 01-I18N-ALIGNMENT.md: explicit conflict resolution record (requirements vs context preference)

affects:
  - All future phases that use i18next (import from i18n.ts)
  - Any phase adding new locale strings (extend common.json files)
  - Phase where I18N-02 is revised to system-locale default (languagePolicy.ts switch-point)

# Tech tracking
tech-stack:
  added:
    - vitest@3.x (unit test framework)
  patterns:
    - "languagePolicy pattern: deterministic language resolution function, mockable for testing"
    - "i18n bootstrap-before-render: initI18n() called in main.tsx before ReactDOM.createRoot"
    - "Immediate language apply: changeLanguage() + shellStore.save() on radio change, no restart needed"
    - "Locale namespaces: single 'common' namespace for Phase 1 baseline strings"

key-files:
  created:
    - src/features/i18n/languagePolicy.ts
    - src/features/i18n/i18n.ts
    - src/features/i18n/default-language.test.ts
    - src/app/providers.tsx
    - src/locales/en/common.json
    - src/locales/tr/common.json
    - vitest.config.ts
    - .planning/phases/01-app-shell-and-baseline-defaults/01-I18N-ALIGNMENT.md
  modified:
    - src/features/settings/sections/LanguageSection.tsx
    - src/shared/contracts/shell.ts (added optional language field)
    - src/main.tsx (bootstrap with i18n init)

key-decisions:
  - "resolveInitialLanguage() enforces English on first launch (I18N-02 wins over context system-locale preference)"
  - "i18next initialised before React render in main.tsx to prevent hydration flicker"
  - "vitest environment: node (not jsdom) — language policy tests are pure logic, no DOM required"
  - "ShellState.language field is optional (undefined = first launch, not a breaking change)"
  - "ENFORCE_ENGLISH_FIRST_LAUNCH block documented as explicit switch-point for future system-locale migration"

patterns-established:
  - "i18n bootstrap pattern: resolveLanguage → initI18n → React mount (prevents hydration flicker)"
  - "Language persistence: shellStore.save({ language }) on every selection change"
  - "Test isolation: mock shellStore.load in unit tests, never invoke Tauri runtime in test suite"

requirements-completed: [I18N-02]

# Metrics
duration: 4min
completed: "2026-03-19"
---

# Phase 1 Plan 02: i18n Baseline Summary

**i18next wired with EN/TR locales, deterministic English-first policy (I18N-02), immediate LanguageSection apply, and automated policy tests via Vitest**

## Performance

- **Duration:** 4 min
- **Started:** 2026-03-19T10:02:40Z
- **Completed:** 2026-03-19T10:07:31Z
- **Tasks:** 3 completed
- **Files modified:** 11

## Accomplishments
- Implemented `resolveInitialLanguage()` with I18N-02-compliant English-first default and documented conflict with context system-locale preference in `01-I18N-ALIGNMENT.md`
- Wired i18next runtime with EN/TR resources, English fallback, and no auto-detection (explicit policy control)
- Replaced LanguageSection placeholder with functional EN/TR radio selector that applies immediately (`changeLanguage` + `shellStore.save` on each selection)
- Bootstrapped i18next before React render in `main.tsx` to prevent translation hydration flicker
- Created Vitest config and 3 automated tests proving I18N-02 compliance (first-launch English, persisted override, unknown locale fallback)

## Task Commits

Each task was committed atomically:

1. **Task 1 RED: Failing tests for resolveInitialLanguage** - `84f1692` (test)
2. **Task 1 GREEN: languagePolicy.ts + I18N-ALIGNMENT.md** - `956ebcf` (feat)
3. **Task 2: i18next runtime + LanguageSection + providers** - `251dcaa` (feat)
4. **Task 3: vitest.config.ts** - `bb5c206` (feat)

**Plan metadata:** _(docs commit — see below)_

## Files Created/Modified
- `src/features/i18n/languagePolicy.ts` — Deterministic first-launch language resolver; I18N-02 compliant; documented switch-point for future system-locale migration
- `src/features/i18n/i18n.ts` — i18next init with EN/TR resources, English fallback, `changeLanguage()` export
- `src/features/i18n/default-language.test.ts` — 3 automated tests: first-launch English, persisted `tr`, unknown locale fallback
- `src/app/providers.tsx` — I18nextProvider + Suspense wrapper for app tree
- `src/locales/en/common.json` — English baseline strings for all Phase 1 settings sections
- `src/locales/tr/common.json` — Turkish baseline strings for all Phase 1 settings sections
- `vitest.config.ts` — Vitest configuration (node environment, 10s timeout)
- `.planning/phases/01-app-shell-and-baseline-defaults/01-I18N-ALIGNMENT.md` — Conflict resolution record with future migration path
- `src/features/settings/sections/LanguageSection.tsx` — Replaced placeholder with functional EN/TR radio selector
- `src/shared/contracts/shell.ts` — Added optional `language?: string` field to `ShellState`
- `src/main.tsx` — Bootstrap order: resolveInitialLanguage → initI18n → React mount with Providers

## Decisions Made
- **Requirements win over context for Phase 1:** I18N-02 mandates English on first launch; the context preference for system-locale default is explicitly deferred and documented in `01-I18N-ALIGNMENT.md` with a one-line migration path
- **Pre-render i18n init:** `initI18n()` is called before `ReactDOM.createRoot()` to prevent the flash of untranslated content on first render
- **Node test environment:** Vitest uses `node` (not `jsdom`) for language policy tests — pure logic, no DOM APIs needed; avoids jsdom dependency
- **Optional `language` field in ShellState:** `undefined` on first launch triggers English default; existing persisted states without the field are handled gracefully

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Installed missing vitest dependency**
- **Found during:** Task 1/3 (TDD RED phase setup)
- **Issue:** `vitest` not in `devDependencies`; `yarn vitest run` command failed with "command not found"
- **Fix:** `yarn add -D vitest@^3.0.0` (compatible with vite@7.x in project)
- **Files modified:** `package.json`, `yarn.lock`
- **Verification:** `yarn vitest run` executes successfully, 3 tests pass
- **Committed in:** `84f1692` (first test commit)

**2. [Rule 3 - Blocking] Vitest environment changed from jsdom to node**
- **Found during:** Task 3 (vitest.config.ts creation)
- **Issue:** `environment: "jsdom"` failed with "Cannot find package 'jsdom'" — jsdom not installed and not needed for pure logic tests
- **Fix:** Changed to `environment: "node"` which requires no extra package; documented jsdom option for future React component tests
- **Files modified:** `vitest.config.ts`
- **Verification:** All 3 tests pass with node environment
- **Committed in:** `bb5c206` (Task 3 commit)

---

**Total deviations:** 2 auto-fixed (2 blocking)
**Impact on plan:** Both auto-fixes were infrastructure setup (test runner). No scope creep. Plan behavior unchanged.

## Issues Encountered
None — all verification commands passed after deviations were resolved.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- i18n runtime is live; any component can use `useTranslation('common')` immediately
- Language selection persists across restarts; shellStore integration complete
- `01-I18N-ALIGNMENT.md` is the authoritative record for Phase 1 i18n requirement vs. context conflict — future agents need not re-litigate this decision
- Ready for Phase 1 completion and Phase 2 (device connection) handoff

---
*Phase: 01-app-shell-and-baseline-defaults*
*Completed: 2026-03-19*

## Self-Check: PASSED

- [x] `src/features/i18n/languagePolicy.ts` — exists
- [x] `src/features/i18n/i18n.ts` — exists
- [x] `src/features/i18n/default-language.test.ts` — exists
- [x] `src/app/providers.tsx` — exists
- [x] `src/locales/en/common.json` — exists
- [x] `src/locales/tr/common.json` — exists
- [x] `vitest.config.ts` — exists
- [x] `.planning/phases/01-app-shell-and-baseline-defaults/01-I18N-ALIGNMENT.md` — exists
- [x] `src/features/settings/sections/LanguageSection.tsx` — exists
- [x] Commit `84f1692` — exists (Task 1 RED)
- [x] Commit `956ebcf` — exists (Task 1 GREEN)
- [x] Commit `251dcaa` — exists (Task 2)
- [x] Commit `bb5c206` — exists (Task 3)
