---
phase: 01-app-shell-and-baseline-defaults
plan: "01"
subsystem: ui
tags: [tauri, rust, react, typescript, tray, single-instance, autostart, store, window-state]

# Dependency graph
requires: []
provides:
  - Tauri v2 + React 19 + TypeScript project scaffold
  - Tray-first runtime shell with single-instance enforcement
  - Close-to-tray behavior with one-time educational hint
  - Tray menu: Open Settings, Status Indicator, Startup Toggle, Quit
  - Canonical shell contracts (src/shared/contracts/shell.ts)
  - Automated structure verifier (scripts/verify/phase01-shell-contracts.mjs)
  - Frontend lifecycle bridge: trayController.ts, windowLifecycle.ts
  - Shell state persistence (plugin-store) with monitor-bounds guard
affects:
  - 01-02 (settings scaffold uses SECTION_IDS, ShellState, windowLifecycle)
  - 01-03 (i18n baseline uses shell bootstrap patterns)
  - All future phases that extend tray menu or persist shell state

# Tech tracking
tech-stack:
  added:
    - tauri 2.10.x (desktop runtime)
    - tauri-plugin-single-instance 2.x
    - tauri-plugin-autostart 2.x
    - tauri-plugin-store 2.x
    - tauri-plugin-window-state 2.x
    - @tauri-apps/api 2.x
    - @tauri-apps/plugin-autostart 2.x
    - @tauri-apps/plugin-store 2.x
    - @tauri-apps/plugin-window-state 2.x
    - react 19.x
    - typescript 5.8.x
    - i18next 25.x (installed, init deferred to plan 03)
    - react-i18next 16.x
  patterns:
    - Tray-driven window control via single show_and_focus_settings() path
    - Close-to-tray interception via on_window_event / onCloseRequested
    - Single-instance plugin registered first in builder chain
    - Shell contracts as single source of truth for all IDs and state shape
    - Monitor-bounds guard on window position restore

key-files:
  created:
    - src/shared/contracts/shell.ts
    - scripts/verify/phase01-shell-contracts.mjs
    - src/features/tray/trayController.ts
    - src/features/shell/windowLifecycle.ts
  modified:
    - src-tauri/src/lib.rs
    - src-tauri/Cargo.toml
    - src-tauri/capabilities/default.json
    - src-tauri/tauri.conf.json
    - package.json

key-decisions:
  - "Used official Tauri v2 plugins (single-instance, autostart, store, window-state) instead of hand-rolled alternatives"
  - "Single show_and_focus_settings() helper centralizes all open/focus paths — tray click, menu item, and second-launch callback all route through it"
  - "Startup toggle default is `false` (off); migration to user setup decision deferred to Phase 4 as documented in research"
  - "Shell contracts file (shell.ts) is single source of truth — downstream modules must never use magic strings for tray/section IDs"
  - "Tray hint persisted via plugin-store with trayHintShown flag; shown once on first close-to-tray"

patterns-established:
  - "Shell contracts pattern: All shared IDs/state defined in src/shared/contracts/shell.ts; import from there, never duplicate"
  - "Single open/focus path: Centralize all window show+focus into one function to avoid divergent behavior"
  - "Automated structure verifier: scripts/verify/*.mjs pattern for deterministic contract gates"

requirements-completed: [UX-01]

# Metrics
duration: 8min
completed: "2026-03-19"
---

# Phase 1 Plan 01: Tray Shell Baseline Summary

**Tauri v2 tray-first runtime shell with single-instance enforcement, close-to-tray behavior, canonical shell contracts, and automated structure verifier**

## Performance

- **Duration:** 8 min
- **Started:** 2026-03-19T09:43:21Z
- **Completed:** 2026-03-19T09:51:59Z
- **Tasks:** 2 completed
- **Files modified:** 10

## Accomplishments
- Scaffolded Tauri v2 + React 19 + TypeScript project with all Phase 1 plugin dependencies installed
- Established `src/shared/contracts/shell.ts` as the canonical single source of truth for tray menu IDs, sidebar section IDs, ShellState shape, store key, and window constraints
- Implemented tray lifecycle in Rust: single-instance (registered first), tray menu (Open Settings, Status Indicator, Startup Toggle, Quit), close-to-tray interception, and centralized show_and_focus_settings()
- Created frontend bridges: `trayController.ts` (autostart toggle) and `windowLifecycle.ts` (state persistence, monitor-bounds guard, one-time tray hint)
- All verification commands pass: contracts verifier (31/31 checks), `cargo check`, `yarn tsc --noEmit`

## Task Commits

Each task was committed atomically:

1. **Task 1: Shell contracts + structure verifier** - `ad5a059` (feat)
2. **Task 2: Tray lifecycle, single-instance, close-to-tray** - `efab154` (feat)

**Plan metadata:** _(final docs commit — see below)_

## Files Created/Modified
- `src/shared/contracts/shell.ts` — Canonical tray menu IDs, section IDs, ShellState interface, defaults, store key, window constraints
- `scripts/verify/phase01-shell-contracts.mjs` — 31-check automated verifier (exits 0 only on full contract presence)
- `src/features/tray/trayController.ts` — Frontend bridge for startup toggle and tray event listeners
- `src/features/shell/windowLifecycle.ts` — Shell state load/save, restore window geometry, monitor-bounds guard, close-to-tray hint
- `src-tauri/src/lib.rs` — Single-instance, tray menu, close-to-tray interception, plugin registration order
- `src-tauri/Cargo.toml` — Added plugin dependencies: single-instance, autostart, store, window-state
- `src-tauri/capabilities/default.json` — Added autostart:allow-* and store/window-state permissions
- `src-tauri/tauri.conf.json` — Window label=main, min constraints, tray icon config
- `package.json` — Added verify:shell-contracts script, plugin JS packages

## Decisions Made
- Used official Tauri v2 plugins over hand-rolled alternatives (fewer edge cases per research recommendation)
- Registered single-instance plugin first in builder chain (required per plugin docs to ensure second-launch callback fires)
- Startup toggle default is `false` (off) for deterministic first-launch; migration to user-preference setup deferred to Phase 4
- Shell contracts file is the single source of truth — downstream modules import from there, never use magic strings

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed `Emitter` trait not in scope for `app.emit()`**
- **Found during:** Task 2 (cargo check)
- **Issue:** Rust `emit()` call requires `tauri::Emitter` trait to be explicitly imported; missing import caused compile error
- **Fix:** Added `Emitter` to the `use tauri::{...}` import block
- **Files modified:** src-tauri/src/lib.rs
- **Verification:** cargo check passes with no errors
- **Committed in:** efab154 (Task 2 commit)

**2. [Rule 1 - Bug] Fixed `TrayIconBuilder.build()` requiring `&M` reference**
- **Found during:** Task 2 (cargo check)
- **Issue:** `.build(app_handle)` passed owned value; API requires `&M` (shared reference)
- **Fix:** Changed to `.build(&app_handle)`
- **Files modified:** src-tauri/src/lib.rs
- **Verification:** cargo check passes
- **Committed in:** efab154 (Task 2 commit)

**3. [Rule 1 - Bug] Fixed plugin-store `StoreOptions` missing required `defaults` field**
- **Found during:** Task 2 (yarn tsc --noEmit)
- **Issue:** `load()` called with `{ autoSave: true }` but `StoreOptions.defaults` is required
- **Fix:** Added `defaults: { [SHELL_STORE_KEY]: DEFAULT_SHELL_STATE }` to store options
- **Files modified:** src/features/shell/windowLifecycle.ts
- **Verification:** yarn tsc --noEmit passes
- **Committed in:** efab154 (Task 2 commit)

**4. [Rule 1 - Bug] Fixed `PhysicalSize`/`PhysicalPosition` must be class instances, not plain objects**
- **Found during:** Task 2 (yarn tsc --noEmit)
- **Issue:** Plain object literals `{ type: "Physical", width, height }` not assignable to `PhysicalSize` (requires class instance with toLogical/toJSON methods)
- **Fix:** Changed to `new PhysicalSize(w, h)` and `new PhysicalPosition(x, y)` with proper imports from `@tauri-apps/api/window`
- **Files modified:** src/features/shell/windowLifecycle.ts
- **Verification:** yarn tsc --noEmit passes
- **Committed in:** efab154 (Task 2 commit)

---

**Total deviations:** 4 auto-fixed (4 × Rule 1 - Bug)
**Impact on plan:** All fixes were compile/type errors caught during verification. No scope creep. Plan executed as designed.

## Issues Encountered
None — all errors caught by automated verification (cargo check, tsc --noEmit) and fixed inline.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Shell baseline is complete and ready for Plan 02 (settings scaffold + persistence)
- `SECTION_IDS`, `ShellState`, `windowLifecycle` are all available for the settings sidebar implementation
- Tray menu actions compile correctly; Startup Toggle event bridge (`tray:startup-toggle-clicked`) is ready to be wired to UI state in Plan 02

---
*Phase: 01-app-shell-and-baseline-defaults*
*Completed: 2026-03-19*

## Self-Check: PASSED

- [x] `src/shared/contracts/shell.ts` — exists
- [x] `scripts/verify/phase01-shell-contracts.mjs` — exists
- [x] `src/features/tray/trayController.ts` — exists
- [x] `src/features/shell/windowLifecycle.ts` — exists
- [x] `src-tauri/src/lib.rs` — modified, commits present
- [x] Commit `ad5a059` — exists (Task 1)
- [x] Commit `efab154` — exists (Task 2)
