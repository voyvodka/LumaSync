---
phase: 20-device-ux-polish-and-channel-write-back
plan: "03"
subsystem: hue-channel-write-back
tags: [hue, write-back, rust, frontend, i18n, tests]
dependency_graph:
  requires: [20-01, 20-02]
  provides: [CHAN-05-write-back]
  affects: [HueChannelMapPanel, room_map.rs, DeviceSection]
tech_stack:
  added: []
  patterns: [reqwest-blocking-tls-skip, tauri-invoke-graceful-fail, window-confirm-dialog]
key_files:
  created: []
  modified:
    - src-tauri/src/commands/room_map.rs
    - src/features/settings/sections/HueChannelMapPanel.tsx
    - src/features/settings/sections/HueChannelMapPanel.test.tsx
    - src/features/settings/sections/DeviceSection.tsx
    - src/locales/en/common.json
    - src/locales/tr/common.json
decisions:
  - "window.confirm used for D-08 confirmation dialog (native, no custom modal)"
  - "Save button only rendered when bridgeIp+username+areaId all present (guard against partial state)"
  - "Error/retry text uses findAllByText in tests due to multiple DOM nodes sharing container text (i18n mock limitation)"
metrics:
  duration_seconds: 376
  completed_date: "2026-04-08"
  tasks_completed: 2
  files_modified: 6
requirements: [CHAN-05]
---

# Phase 20 Plan 03: CHAN-05 Channel Write-Back Summary

**One-liner:** CLIP v2 PUT write-back for Hue channel positions with Rust handler, Beta-badged save button, confirm dialog, and inline success/error display.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Implement Rust update_hue_channel_positions handler | fc79a5c | src-tauri/src/commands/room_map.rs |
| 2 | Add save button UI, confirm dialog, inline result, i18n keys, and tests | 762a31b | HueChannelMapPanel.tsx, HueChannelMapPanel.test.tsx, DeviceSection.tsx, en/tr common.json |

## What Was Built

### Rust Handler (Task 1)

Replaced the Phase 14 stub at `update_hue_channel_positions` with a real implementation:

- Accepts 4 parameters: `channels`, `bridge_ip`, `username`, `area_id`
- Builds a `reqwest::blocking::Client` with `danger_accept_invalid_certs(true)` (Hue bridges use self-signed TLS)
- Converts `Vec<HueChannelPlacement>` to CLIP v2 channel_positions JSON payload
- Sends PUT to `https://{bridge_ip}/clip/v2/resource/entertainment_configuration/{area_id}`
- Returns typed status codes:
  - `HUE_CHANNEL_POSITIONS_UPDATED` on HTTP 2xx success
  - `CHAN_WB_SCHEMA_REJECTED` on HTTP 4xx/5xx with response body in details
  - `CHAN_WB_NETWORK_ERROR` on connection/build failure
- Never panics — all error paths return `CommandStatus` (graceful-fail per D-10)

### Frontend (Task 2)

**HueChannelMapPanel:**
- Added props: `bridgeIp`, `username`, `areaId`, `isStreaming`
- Added state: `isSaving`, `saveResult`
- Added `handleSaveToBridge` handler: confirm dialog → invoke → update result state
- Beta badge (amber-100 bg) + save button rendered only when all write-back props present
- Button disabled + tooltip when `isStreaming=true`
- Inline success (emerald-600) / error (rose-600) with retry link
- Success auto-dismisses after 3000ms

**DeviceSection:**
- Added `credentials` to useHueOnboarding destructuring
- Passes `bridgeIp={selectedBridge?.ip}`, `username={credentials?.username}`, `areaId={selectedArea?.id}`, `isStreaming={runtimeStatus?.state === "Running"}` to HueChannelMapPanel

**i18n:**
- EN + TR: `saveToBridge`, `saveToBridgeTooltip`, `saving`, `savedToBridge`, `saveToBridgeError`, `saveToBridgeErrorRetry`, `saveConfirm`, `beta`
- EN + TR: `writeback.codes.CHAN_WB_SCHEMA_REJECTED`, `CHAN_WB_STREAM_ACTIVE`, `CHAN_WB_NETWORK_ERROR`
- Locale parity test passes

**Tests:**
- 4 new CHAN-05 test cases in `HueChannelMapPanel.test.tsx`
- All 12 tests pass (including pre-existing CHAN-01 through CHAN-04)

## Verification Results

- `yarn check:rust` — PASSED (cargo check 0 errors)
- `yarn vitest run src/features/settings/sections/HueChannelMapPanel.test.tsx` — PASSED (12/12)
- `yarn vitest run src/features/i18n/locale-parity.test.ts` — PASSED (2/2)
- `yarn verify:shell-contracts` — PASSED (45/45 checks)
- `yarn typecheck` — PASSED (0 TypeScript errors)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] vi.spyOn(window, "confirm") fails in jsdom**
- **Found during:** Task 2 — test writing
- **Issue:** jsdom does not define `window.confirm`, so `vi.spyOn()` throws "can only spy on a function. Received undefined"
- **Fix:** Use `window.confirm = vi.fn().mockReturnValueOnce(...)` direct assignment instead of spyOn
- **Files modified:** HueChannelMapPanel.test.tsx
- **Commit:** 762a31b

**2. [Rule 1 - Bug] findByText fails with "multiple elements" on error test**
- **Found during:** Task 2 — test iteration
- **Issue:** The error div and retry button share parent text node, causing `findByText` to match both
- **Fix:** Switched to `findAllByText` + `getAllByRole` which accept multiple matches
- **Files modified:** HueChannelMapPanel.test.tsx
- **Commit:** 762a31b

## Known Stubs

None — all CHAN-05 functionality is fully wired. The Rust handler sends a real PUT to the bridge; the frontend invokes it with real credentials and area ID passed from DeviceSection.

## Self-Check: PASSED
