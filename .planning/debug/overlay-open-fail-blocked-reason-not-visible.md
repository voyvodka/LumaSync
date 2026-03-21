---
status: diagnosed
trigger: "Overlay open fail durumunda test pattern toggle bloke olur ve reason metni gorunur, fakat overlay gorunmuyor."
created: 2026-03-20T12:40:04Z
updated: 2026-03-20T12:45:15Z
---

## Current Focus

hypothesis: Root cause confirmed: OS-level display overlay is never created; blocked reason UX is tied to an in-editor state that users cannot validate as intended when overlay itself never appears.
test: Correlate Test 8 symptom with Test 7 root-cause evidence from the same implementation path.
expecting: Same backend stub behavior explains both missing overlay visibility and reason-verification failure.
next_action: return diagnose-only root cause report

## Symptoms

expected: Overlay open fail durumunda test pattern toggle bloke olur ve kullaniciya acik reason metni gosterilir.
actual: overlay gorunmuyor bunu goremiyorum
errors: none reported
reproduction: Test 8 in UAT
started: Discovered during UAT

## Eliminated

## Evidence

- timestamp: 2026-03-20T12:41:10Z
  checked: codebase search for overlay-open failure and blocked reason paths
  found: backend returns overlay error code+reason; frontend has blocked reason fields and renders message in CalibrationOverlay component
  implication: candidate mismatch is UI message visibility scope rather than missing backend error detail

- timestamp: 2026-03-20T12:42:27Z
  checked: `CalibrationOverlay.tsx`, `displayTargetState.ts`, `calibration.rs`
  found: blocked reason chip is rendered only when `displayTarget.blocked` inside CalibrationOverlay; backend open_display_overlay returns OVERLAY_OPEN_FAILED only for invalid display id and does not create an OS overlay window
  implication: user-visible reason requires calibration editor to be open and to hit blocked state in this in-overlay UI

- timestamp: 2026-03-20T12:43:21Z
  checked: symbol search for overlay open entrypoints and blocked reason keys
  found: app-level openCalibrationOverlay path and settings edit callback wiring exist; blocked reason i18n lookup uses `calibration.overlay.blockedReason` + fallback key
  implication: next step is validating whether message key exists and whether UI entrypoint is actually reachable in failing flow

- timestamp: 2026-03-20T12:44:18Z
  checked: `App.tsx`, `entryFlow.ts`, `src/locales/tr/common.json`, `src/locales/en/common.json`
  found: settings edit always opens CalibrationOverlay (`open=true`, `step=editor`); blocked reason translation key exists in both locales as `{{code}}: {{reason}}`
  implication: missing reason is not caused by absent i18n key or missing edit entrypoint wiring in current code snapshot

- timestamp: 2026-03-20T12:45:15Z
  checked: `.planning/debug/test-pattern-overlay-missing-on-display-switch.md` cross-issue evidence
  found: shared path confirms `open_display_overlay` only updates `active_display_id` and returns success/error, but never opens an OS-level overlay window/surface
  implication: user cannot observe overlay-dependent behavior in UAT (including blocked-reason expectation tied to failed overlay open scenario)

## Resolution

root_cause: `src-tauri/src/commands/calibration.rs` icindeki `open_display_overlay` implementasyonu gercek OS-level overlay olusturmuyor; yalnizca display id dogrulayip `OverlayState.active_display_id` set ediyor. Bu nedenle overlay gorunurlugu yok ve Test 8'de beklenen open-fail reason davranisi pratikte dogrulanamiyor.
fix:
verification:
files_changed: []
