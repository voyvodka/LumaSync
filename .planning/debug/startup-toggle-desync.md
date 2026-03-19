---
status: diagnosed
trigger: "Investigate issue: uat-03-startup-toggle-desync"
created: 2026-03-19T10:44:02Z
updated: 2026-03-19T10:45:31Z
---

## Current Focus

hypothesis: Confirmed - startup autostart state and tray checkmark are independent in current architecture.
test: Completed static trace for all startup-toggle code paths in frontend and Rust.
expecting: N/A (root cause confirmed).
next_action: return root cause diagnosis (goal: find_root_cause_only)

## Symptoms

expected: Startup toggle uygulama ici ve tray menu arasinda cift yonlu senkron kalir.
actual: Tray'den degisince UI aninda guncelleniyor; uygulamadan degisince tray guncellenmiyor ve bir noktadan sonra ters calisiyor.
errors: None reported
reproduction: Test 3 in UAT
started: Discovered during UAT

## Eliminated

- timestamp: 2026-03-19T10:45:01Z
  checked: src/features/settings/sections/StartupTraySection.tsx
  found: UI loads state via `getStartupEnabled()` and updates local React state; both tray event and UI button call the same `toggleStartup()` function.
  implication: UI can reflect autostart state, but this does not prove tray checkmark is updated.

- timestamp: 2026-03-19T10:45:01Z
  checked: src/features/tray/trayController.ts
  found: Only autostart operations are `isEnabled()/enable()/disable()`; no command/event updates tray menu checkbox state.
  implication: Frontend controls autostart flag but has no mechanism to keep tray checkmark aligned.

- timestamp: 2026-03-19T10:45:01Z
  checked: src-tauri/src/lib.rs
  found: Tray menu creates `CheckMenuItem` with initial `checked=false`; on `startup-toggle` click Rust only emits `tray:startup-toggle-clicked` and never syncs checkbox from actual autostart state.
  implication: Tray checkmark can drift from real autostart state, especially after UI-initiated toggles or startup initialization.

- timestamp: 2026-03-19T10:45:01Z
  checked: repository search for `set_checked` and startup-toggle sync paths
  found: No Rust code updates `CheckMenuItem` checked state after creation.
  implication: There is no bidirectional synchronization path by design in current implementation.

- timestamp: 2026-03-19T10:45:31Z
  checked: full startup-toggle cross-search in src and src-tauri/src
  found: Only tray->frontend event bridge exists (`app.emit("tray:startup-toggle-clicked")` -> `listenStartupToggle`), with no frontend->tray update command or startup-time tray state initialization from autostart.
  implication: Behavior exactly matches UAT report: tray click updates UI, UI click does not update tray, and desynced tray checkmark causes perceived inverse toggling.

## Evidence

<!-- none yet -->

## Resolution

root_cause: "`CheckMenuItem` checked state in Rust tray is never synchronized with real autostart state managed by plugin-autostart. Tray menu starts with hardcoded `checked=false` and only emits click events to frontend; frontend toggles autostart but cannot update tray checkmark. This creates one-way sync and eventual inverse behavior when tray checkmark drifts from actual autostart state."
fix: ""
verification: ""
files_changed: []
