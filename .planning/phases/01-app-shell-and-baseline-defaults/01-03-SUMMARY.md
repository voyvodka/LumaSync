---
phase: 01-app-shell-and-baseline-defaults
plan: "03"
subsystem: ui
tags: [tauri, react, typescript, settings, persistence, css, shell-state]

# Dependency graph
requires:
  - phase: 01-app-shell-and-baseline-defaults
    provides: Shell contracts (SECTION_IDS, ShellState, windowLifecycle), tray lifecycle, plugin-store setup
provides:
  - SettingsLayout component (sidebar + content panel SPA navigation)
  - Phase 1 baseline sections: General, StartupTray, Language (slot), AboutLogs, Device
  - shellStore.ts: public persistence API for shell state load/save/reset
  - App.tsx wired to SettingsLayout with section state restore and lifecycle bootstrap
  - Design token system (CSS variables, light/dark mode support)
  - docs/manual/phase-01-tray-checklist.md: 7-section repeatable manual smoke test
affects:
  - 01-02 (LanguageSection slot ready for i18n wiring)
  - All future phases that extend settings sections or shell state

# Tech tracking
tech-stack:
  added: []
  patterns:
    - Controlled section state in App.tsx — SettingsLayout is stateless, receives activeSection + onSectionChange
    - CSS design token system — all colors/typography via :root CSS variables with dark mode @media
    - shellStore.ts thin wrapper pattern — delegates to windowLifecycle, single store instance
    - Settings section barrel — each section is a standalone component, SectionContent switch in SettingsLayout

key-files:
  created:
    - src/features/settings/SettingsLayout.tsx
    - src/features/settings/SettingsLayout.css
    - src/features/settings/sections/GeneralSection.tsx
    - src/features/settings/sections/StartupTraySection.tsx
    - src/features/settings/sections/LanguageSection.tsx
    - src/features/settings/sections/AboutLogsSection.tsx
    - src/features/settings/sections/DeviceSection.tsx
    - src/features/persistence/shellStore.ts
    - docs/manual/phase-01-tray-checklist.md
  modified:
    - src/App.tsx
    - src/App.css

key-decisions:
  - "SettingsLayout is a controlled component — App.tsx owns section state for persistence (not internal useState)"
  - "CSS design tokens via :root variables only — no Tailwind, no extra framework; keeps bundle lean and avoids setup complexity"
  - "shellStore.ts wraps windowLifecycle instead of owning its own store instance — single plugin-store session avoids double-open issues"
  - "Language section is a placeholder slot in Plan 03 — content wired in Plan 02 (i18n baseline) per depends_on order"

patterns-established:
  - "Controlled settings navigation: App.tsx owns section state, persists on every change, restores from store on mount"
  - "CSS token system: design tokens in App.css :root, component-specific styles in co-located .css files"
  - "Settings section pattern: each section is a standalone component in sections/ directory, no shared state"

requirements-completed: [UX-01]

# Metrics
duration: 4min
completed: "2026-03-19"
---

# Phase 1 Plan 03: Settings Shell Scaffold Summary

**Sidebar + content settings shell with Phase 1 baseline sections, CSS design token system, and shell state persistence module**

## Performance

- **Duration:** 4 min
- **Started:** 2026-03-19T09:55:18Z
- **Completed:** 2026-03-19T09:59:22Z
- **Tasks:** 2 completed
- **Files modified:** 11

## Accomplishments
- Built SettingsLayout (sidebar + content panel) as a controlled React component wired to App.tsx with section state restore from plugin-store on mount
- Implemented all 5 Phase 1 baseline sections (General, Startup & Tray with autostart toggle, Language slot, About & Logs, Device)
- Replaced default App.css with clean CSS design token system (light/dark variables, reset, no framework)
- Created `shellStore.ts` as a thin public API over windowLifecycle for shell state load/save/reset
- Authored `docs/manual/phase-01-tray-checklist.md`: 7-section repeatable manual smoke test for UX-01 tray behavior

## Task Commits

Each task was committed atomically:

1. **Task 1: Settings shell layout and Phase 1 baseline sections** - `f5bbe30` (feat)
2. **Task 2: Shell state persistence module and tray smoke checklist** - `f2de774` (feat)

**Plan metadata:** _(docs commit — see below)_

## Files Created/Modified
- `src/features/settings/SettingsLayout.tsx` — Sidebar + content settings shell; controlled section navigation
- `src/features/settings/SettingsLayout.css` — Shell layout, sidebar, content area, section, toggle, row styles
- `src/features/settings/sections/GeneralSection.tsx` — General settings placeholder
- `src/features/settings/sections/StartupTraySection.tsx` — Autostart toggle + tray info section
- `src/features/settings/sections/LanguageSection.tsx` — Language selection slot (wired in Plan 02)
- `src/features/settings/sections/AboutLogsSection.tsx` — Version info and logs description section
- `src/features/settings/sections/DeviceSection.tsx` — Device connection placeholder (Phase 2 scope)
- `src/features/persistence/shellStore.ts` — Public API for shell state load/save/reset (wraps windowLifecycle)
- `docs/manual/phase-01-tray-checklist.md` — 7-section repeatable manual validation checklist for UX-01
- `src/App.tsx` — Replaced default scaffold with SettingsLayout bootstrap + lifecycle init + section persistence
- `src/App.css` — Replaced with CSS design tokens (light/dark mode), reset, and base typography

## Decisions Made
- SettingsLayout is a controlled component — App.tsx owns section state so it can persist to store without lifting state through arbitrary intermediaries
- CSS design tokens via `:root` variables only — Tailwind was not set up in this project; plain CSS keeps the bundle lean and avoids framework setup without sacrificing visual quality
- `shellStore.ts` delegates to `windowLifecycle` rather than opening its own store instance — avoids double-open races with Tauri plugin-store
- Language section is a slot/placeholder in this plan per the wave ordering: Plan 03 → Plan 02 (i18n) consumes the slot

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None — all verification commands passed on first run (`node scripts/verify/phase01-shell-contracts.mjs` 31/31, `yarn tsc --noEmit`).

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Settings shell is ready for Plan 02 (i18n baseline): LanguageSection slot exists, App.tsx bootstrap is ready for i18n provider wrapping
- `shellStore.ts` is importable for Plan 02 language persistence integration
- Tray checklist at `docs/manual/phase-01-tray-checklist.md` ready for UX-01 manual validation when `yarn tauri dev` is running

---
*Phase: 01-app-shell-and-baseline-defaults*
*Completed: 2026-03-19*

## Self-Check: PASSED

- [x] `src/features/settings/SettingsLayout.tsx` — exists
- [x] `src/features/settings/SettingsLayout.css` — exists
- [x] `src/features/settings/sections/GeneralSection.tsx` — exists
- [x] `src/features/settings/sections/StartupTraySection.tsx` — exists
- [x] `src/features/settings/sections/LanguageSection.tsx` — exists
- [x] `src/features/settings/sections/AboutLogsSection.tsx` — exists
- [x] `src/features/settings/sections/DeviceSection.tsx` — exists
- [x] `src/features/persistence/shellStore.ts` — exists
- [x] `docs/manual/phase-01-tray-checklist.md` — exists
- [x] Commit `f5bbe30` — exists (Task 1)
- [x] Commit `f2de774` — exists (Task 2)
