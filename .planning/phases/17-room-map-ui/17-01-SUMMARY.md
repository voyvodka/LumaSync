---
phase: 17-room-map-ui
plan: "01"
subsystem: room-map
tags: [tauri-plugins, persist-hook, i18n, test-stubs]
dependency_graph:
  requires: []
  provides: [tauri-dialog-plugin, tauri-fs-plugin, copy_background_image, useRoomMapPersist, room-map-i18n, wave0-test-stubs]
  affects: [17-02, 17-03, 17-04]
tech_stack:
  added:
    - "@tauri-apps/plugin-dialog@2.7.0"
    - "@tauri-apps/plugin-fs@2.5.0"
    - "tauri-plugin-dialog = \"2\""
    - "tauri-plugin-fs = \"2\""
  patterns:
    - "shellStore.load()/save() for roomMap persistence with version increment"
    - "cancelled flag pattern for safe async effect cleanup"
    - "useRef for version tracking without triggering re-renders"
key_files:
  created:
    - src/features/settings/sections/room-map/useRoomMapPersist.ts
    - src/features/settings/sections/room-map/useRoomMapPersist.test.ts
    - src/features/settings/sections/room-map/RoomMapEditor.test.tsx
    - src/features/settings/sections/room-map/FurnitureObject.test.tsx
    - src/features/settings/sections/room-map/UsbStripObject.test.tsx
    - src/features/settings/sections/room-map/RoomMapToolbar.test.tsx
    - src/features/settings/sections/room-map/HueChannelOverlay.test.tsx
  modified:
    - package.json
    - yarn.lock
    - src-tauri/Cargo.toml
    - src-tauri/Cargo.lock
    - src-tauri/capabilities/default.json
    - src-tauri/src/lib.rs
    - src-tauri/src/commands/room_map.rs
    - src/locales/en/common.json
    - src/locales/tr/common.json
decisions:
  - "fs:allow-app-data-dir is not a valid Tauri 2 fs permission — replaced with fs:allow-appdata-write and fs:allow-appdata-read (minimum required for app data directory access)"
  - "use tauri::Manager trait must be imported explicitly for app_handle.path() to resolve — added to room_map.rs"
  - "vi.fn<[], Promise<T>>() generic syntax incompatible with this Vitest version — replaced with vi.fn() untyped to avoid TS2558 errors"
metrics:
  duration_seconds: 230
  completed_date: "2026-04-06"
  tasks_completed: 2
  tasks_total: 2
  files_created: 7
  files_modified: 9
---

# Phase 17 Plan 01: Foundation — Plugins, Persist Hook, i18n, Test Stubs

**One-liner:** Tauri dialog/fs plugins registered with copy_background_image Rust command, useRoomMapPersist hook wired to shellStore with version increment, all 28 i18n keys added in en+tr, and Wave 0 it.todo stubs covering ROOM-01/02/04/05/06/07/08.

## Tasks Completed

| Task | Description | Commit |
|------|-------------|--------|
| 1 | Install Tauri dialog/fs plugins, register capabilities, add copy_background_image Rust command | b54c080 |
| 2 | Create useRoomMapPersist hook, add all i18n keys, scaffold Wave 0 test stubs | c442924 |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Invalid Tauri fs capability permission name**
- **Found during:** Task 1 — `cargo check` failure
- **Issue:** Plan specified `fs:allow-app-data-dir` which does not exist in tauri-plugin-fs permission set
- **Fix:** Replaced with `fs:allow-appdata-write` and `fs:allow-appdata-read` (correct Tauri 2 names)
- **Files modified:** `src-tauri/capabilities/default.json`
- **Commit:** b54c080

**2. [Rule 1 - Bug] Missing `use tauri::Manager` import for app_handle.path()**
- **Found during:** Task 1 — second `cargo check` failure
- **Issue:** `AppHandle::path()` comes from the `Manager` trait which must be explicitly imported
- **Fix:** Added `use tauri::Manager;` to `src-tauri/src/commands/room_map.rs`
- **Files modified:** `src-tauri/src/commands/room_map.rs`
- **Commit:** b54c080

**3. [Rule 1 - Bug] Incompatible vi.fn generic syntax in test file**
- **Found during:** Task 2 — `yarn typecheck` failure
- **Issue:** `vi.fn<[], Promise<T>>()` syntax causes TS2558 (Expected 0-1 type arguments) with this Vitest version
- **Fix:** Replaced with `vi.fn()` (untyped) which TypeScript infers correctly through the mock setup
- **Files modified:** `src/features/settings/sections/room-map/useRoomMapPersist.test.ts`
- **Commit:** c442924

## Known Stubs

None — the `useRoomMapPersist` hook is fully wired to shellStore. The Wave 0 test files contain `it.todo()` stubs intentionally, to be implemented in Plans 02 and 03 when their target components are created.

## Verification Results

- `cargo check` passes (Rust compiles with both new plugins)
- `yarn typecheck` passes (no TS errors in hook or test files)
- All 7 test stub files exist in `src/features/settings/sections/room-map/`
- Both en and tr locale files contain complete roomMap key tree (toolbar, empty, furniture, settings, persistError, usbStrip, hueChannel)

## Self-Check: PASSED
