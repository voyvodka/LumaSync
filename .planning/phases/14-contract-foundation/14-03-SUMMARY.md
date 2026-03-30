---
phase: 14-contract-foundation
plan: "03"
subsystem: verification
tags: [contracts, verification, shell-contracts, room-map, hue]
dependency_graph:
  requires: ["14-01", "14-02"]
  provides: ["contract-verification-gate"]
  affects: ["scripts/verify/phase01-shell-contracts.mjs"]
tech_stack:
  added: []
  patterns: ["contract-first verification", "deterministic gate scripts"]
key_files:
  modified:
    - scripts/verify/phase01-shell-contracts.mjs
decisions:
  - "ID_TO_CONST mapping handles hyphenated section IDs (led-setup, room-map) that break naïve toUpperCase() matching"
  - "REQUIRED_SETTINGS_TAB_IDS removed entirely as the settings tab concept no longer exists in the architecture"
  - "hue.ts and roomMap.ts are read as separate files to keep shell.ts checks isolated from new contract files"
metrics:
  duration_minutes: 8
  completed_date: "2026-03-30"
  tasks_completed: 2
  files_modified: 1
---

# Phase 14 Plan 03: Contract Verification Script Repair and Extension Summary

**One-liner:** Repaired 8 failing checks in shell contracts verifier by replacing obsolete section IDs, removing deleted tab checks, fixing hyphenated ID matching, and adding 14 new checks for room map types, commands, and Hue channel status codes.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Repair broken checks and remove obsolete tab ID verification | ea30445 | scripts/verify/phase01-shell-contracts.mjs |
| 2 | Extend script with room map contract checks and run full validation | 11877d3 | scripts/verify/phase01-shell-contracts.mjs |

## What Was Done

### Task 1 — Repair
The verification script had 8/30 failing checks because it referenced the old architecture's section IDs (`control`, `calibration`, `settings`) instead of the current ones (`lights`, `led-setup`, `devices`, `system`, `room-map`). Additionally, the `SECTION_ORDER` completeness check used `id.toUpperCase()` which fails for hyphenated IDs like `led-setup` (produces `LED-SETUP` instead of `LED_SETUP`).

Fixes applied:
- Replaced `REQUIRED_SECTION_IDS` with the 5 current section IDs
- Removed `REQUIRED_SETTINGS_TAB_IDS` constant and its check loop entirely
- Replaced the `toUpperCase()` matching with an `ID_TO_CONST` mapping object

Result: 31/31 checks passed.

### Task 2 — Extension
Added 14 new checks covering Phase 14 additions:
- `roomMap` and `roomMapVersion` added to `REQUIRED_STATE_FIELDS` (2 checks)
- New `[ Hue channel position commands ]` section checking `update_hue_channel_positions` command and `HUE_CHANNEL_POSITIONS_UPDATED` / `HUE_CHANNEL_POSITIONS_FAILED` status codes (3 checks)
- New `[ Room map contract types ]` section checking all 7 exported interfaces in `roomMap.ts` (7 checks)
- New `[ Room map commands ]` section checking `save_room_map` and `load_room_map` (2 checks)

Result: 45/45 checks passed. `yarn check:all` green.

## Verification Results

```
yarn verify:shell-contracts  →  All 45 checks passed — shell contracts verified.
yarn check:all               →  Done in 3.56s. (JS typecheck + Rust check + shell contracts all green)
```

## Deviations from Plan

None - plan executed exactly as written.

## Known Stubs

None. The verification script reads real contract files — no mock or hardcoded data paths.

## Self-Check: PASSED

- `scripts/verify/phase01-shell-contracts.mjs` exists and passes all 45 checks
- Commit ea30445 exists (Task 1)
- Commit 11877d3 exists (Task 2)
- `yarn check:all` exits with code 0
