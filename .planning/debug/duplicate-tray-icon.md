---
status: diagnosed
trigger: "Investigate issue: uat-01-duplicate-tray-icon - App launch creates two tray icons instead of one."
created: 2026-03-19T10:44:17Z
updated: 2026-03-19T10:46:04Z
---

## Current Focus

hypothesis: Confirmed — duplicate tray icon is caused by both config-driven tray initialization and runtime tray builder initialization.
test: Diagnosis complete (root cause found).
expecting: Report root cause with involved files and fix direction.
next_action: return diagnosis

## Symptoms

expected: Uygulama acildiginda tek bir tray icon gorunur.
actual: Kullanici iki tane uygulama tray ikonu gordugunu raporladi.
errors: None reported
reproduction: Test 1 in UAT
started: Discovered during UAT

## Eliminated

<!-- none yet -->

## Evidence

- timestamp: 2026-03-19T10:44:58Z
  checked: src-tauri/src/lib.rs startup sequence and setup block
  found: Tray icon is created once via a single `TrayIconBuilder::new().build(...)` call inside `setup`.
  implication: Duplicate icon is not explained by two explicit tray builder calls in this file.

- timestamp: 2026-03-19T10:44:58Z
  checked: src-tauri/src/main.rs
  found: Entrypoint only calls `lumasync_lib::run()` once.
  implication: Duplicate tray icon is unlikely caused by duplicate entrypoint invocation in main.rs itself.

- timestamp: 2026-03-19T10:45:17Z
  checked: repository-wide search for tray creation APIs
  found: Only concrete tray creation API usage is `TrayIconBuilder::new()` in `src-tauri/src/lib.rs`; no second Rust tray builder path found.
  implication: Another source outside direct Rust builder code (e.g. config-driven tray initialization) is now the primary suspect.

- timestamp: 2026-03-19T10:45:44Z
  checked: src-tauri/tauri.conf.json
  found: `app.trayIcon` is defined with `iconPath` and `iconAsTemplate`, while `src-tauri/src/lib.rs` also creates a tray icon in `setup` via `TrayIconBuilder::new().build(...)`.
  implication: Two independent tray initialization mechanisms are configured, which directly explains two tray icons at launch.

- timestamp: 2026-03-19T10:46:04Z
  checked: .planning/phases/01-app-shell-and-baseline-defaults/01-01-SUMMARY.md
  found: Implementation summary explicitly records both `src-tauri/src/lib.rs` tray lifecycle work and `src-tauri/tauri.conf.json` tray icon config addition.
  implication: Project history confirms both mechanisms were introduced in the same phase, matching the observed duplicate icon symptom.

## Resolution

root_cause: `src-tauri/tauri.conf.json` defines `app.trayIcon` (config-managed tray icon) while `src-tauri/src/lib.rs` also manually creates a tray icon via `TrayIconBuilder` in setup; both execute on launch and produce two tray icons.
fix: Diagnose-only mode; no code changes applied.
verification: Static code/config correlation completed; symptom mechanism explained directly.
files_changed: []
