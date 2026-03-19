---
status: diagnosed
trigger: "Investigate issue: uat-04-macos-fullscreen-close-black-screen"
created: 2026-03-19T10:44:16Z
updated: 2026-03-19T10:44:58Z
---

## Current Focus

hypothesis: Fullscreen close-to-tray lifecycle on macOS leaves the desktop-space transition in an inconsistent state because the app hides without first exiting fullscreen.
test: Read Rust close-request intercept and show/hide lifecycle to verify whether fullscreen state is handled before hide on macOS.
expecting: If true, close-request path will prevent close and call `window.hide()` (or equivalent) without checking/exiting fullscreen.
next_action: Correlate close-handler behavior with fullscreen-specific symptom and finalize root-cause diagnosis.

## Symptoms

expected: Tam ekran modundan pencere kapatilip tray'e alindiginda ekran artefakti/black screen olusmamali.
actual: Kullanici fullscreen moddayken carpi ile kapatinca siyah ekran kaldigini raporladi.
errors: None reported
reproduction: Test 4 in UAT
started: Discovered during UAT

## Eliminated

<!-- none yet -->

## Evidence

- timestamp: 2026-03-19T10:44:33Z
  checked: Global code search for fullscreen and close-to-tray lifecycle hooks.
  found: Fullscreen-related handling is not present in app shell code; close-to-tray behavior is primarily wired in Rust runtime (`src-tauri/src/lib.rs`) with frontend only showing hint/log behavior.
  implication: Root cause is likely in native window lifecycle handling rather than React UI layer.
- timestamp: 2026-03-19T10:44:58Z
  checked: `src-tauri/src/lib.rs` close interception and show/focus logic.
  found: On every `CloseRequested`, app always calls `api.prevent_close()` then immediately `window.hide()`; no fullscreen-state check or `set_fullscreen(false)` path exists before hide.
  implication: In macOS fullscreen space, hiding directly from fullscreen can leave compositor/space transition artifact (reported black screen), matching the observed UAT behavior.
- timestamp: 2026-03-19T10:44:58Z
  checked: Frontend lifecycle files (`src/features/shell/windowLifecycle.ts`, `src/App.tsx`).
  found: Frontend only restores window geometry and handles one-time tray hint; it does not control OS-level close behavior when user clicks the native close button.
  implication: Symptom origin is in Rust window-event close handling, not React store/listener logic.

## Resolution

root_cause: macOS fullscreen close-to-tray path hides the window immediately on `CloseRequested` without exiting fullscreen first; this leaves fullscreen-space/compositor artifact (black screen) when user clicks close while fullscreen.
fix: 
verification: 
files_changed: []
