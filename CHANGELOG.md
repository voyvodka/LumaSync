# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog:
https://keepachangelog.com/en/1.1.0/

## [Unreleased]

---

## [1.0.3] — 2026-04-08

### Added

- Room map canvas editor with draggable furniture, TV anchor, and USB strip objects (`RoomMapEditor`, `RoomMapCanvas`, `RoomMapToolbar`)
- `HueChannelOverlay` renders channel positions on the room map using a `[-1,1]` normalized coordinate system
- `HueChannelMapPanel`: drag-and-drop single and multi-channel positioning, z-axis detail strip, coordinate tooltips, positions persisted via `shellStore`
- Zone auto-derivation: `deriveZones` algorithm maps LED strip positions to Hue channel regions automatically (13 unit tests)
- `ZoneDeriveOverlay` and `ZoneListPanel` for reviewing, renaming, and deleting derived zones; zone assignment mode in `HueChannelOverlay`
- `HueReadySummaryCard` in Device section — shows stream state indicator, entertainment area name, and bridge IP when Hue is connected
- `update_hue_channel_positions` Rust command writes edited channel positions back to the Hue bridge with save confirmation UI
- Target-aware lighting pipeline: `targets` field on `LightingModeConfig` selects which output devices (USB / Hue) participate per mode
- `resolveDefaultTargets` helper preserves backward compatibility with persisted configs that predate the targets field
- USB hot-plug detection: suggestion banner appears when a USB controller is plugged in while Hue-only mode is active
- Startup target filtering: USB target is silently removed from persisted state if the device is not connected on launch
- Delta start/stop in `handleOutputTargetsChange` — adding or removing an output target while a mode is active no longer restarts the full pipeline
- `HueTelemetryGrid` component in Diagnostics tab showing live DTLS stream metrics
- `HUE_FAULT_CODES` typed constant map replaces raw string matching for all DTLS fault conditions
- `FullTelemetrySnapshot` type and `get_full_telemetry_snapshot` Tauri command for combined runtime diagnostics
- `simulate_hue_fault` Rust command for fault injection during development and testing
- `copy_background_image` Rust command for importing a floor-plan background into the room map
- `roomMap.ts` contract: placement types, `RoomMapObject` discriminated union, coordinate definitions
- `UPDATE_CHANNEL_POSITIONS` command and associated status codes added to `hue.ts` contract
- `roomMap` persistence field and `ROOM_MAP` section ID added to `shell.ts` contract
- Shell contracts verifier extended to validate room map and Hue channel position contract coverage
- `targetFailed` i18n key under `device.hue` namespace (EN + TR)
- Tauri `dialog` and `fs` plugins for background image import

### Fixed

- `handleOutputTargetsChange` no longer stops an active lighting mode when a target is only being added (not removed)
- DTLS reconnect monitor correctly detects and registers thread death in all failure paths

---

## [1.1.0] — 2026-03-28

### Added

- Philips Hue DTLS 1.2 PSK entertainment streaming over UDP (cipher `PSK-AES128-GCM-SHA256`, port 2100) using vendored OpenSSL
- `ShutdownSignal` mechanism: DTLS sender thread signals clean exit; `stop_hue_stream` waits up to 3 s and marks timeout on failure
- DTLS thread death detection: `get_hue_stream_status` probes shutdown signal and registers a transient fault if the thread died silently while state was `Running`
- `HueSolidColorSnapshot` exposed in `get_hue_stream_status` response — tracks last pushed solid color for UI sync
- Hue → UI color sync: when Hue transitions to `Running`, the last solid color is reflected in the solid color picker exactly once per connection (no continuous polling)
- Stream running indicator on Hue output chip in Control page (pulsing emerald dot)
- Action-aware retry button in Device section — label changes based on `actionHint` (Re-pair, Revalidate, Retry…)
- Amber banner in Device section when pairing is waiting for the Hue bridge link button press (`HUE_PAIRING_PENDING_LINK_BUTTON`)
- "Stop retrying" button cancels an active Hue reconnect loop
- `✓ Saved` feedback toast (2 s) on Hue channel-to-region override save
- `SHELL_COMMANDS` constant map in `shell.ts` contract; `trayController.ts` migrated to use it
- Initial open-source contributor documentation (`CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`)
- MIT License

### Changed

- `stop_with_timeout` now clears `persistent_sender` on user-initiated stops (`ModeControl`, `DeviceSurface`) and preserves it on system-triggered stops
- `start_hue_stream` guards against race condition: re-checks `owner.state` after async credential fetch before storing stream context
- `App.tsx` polls `get_hue_stream_status` every 5 s when Hue is active; removes "hue" from `activeOutputTargets` when backend reports `Failed` or `Idle`
- Device Settings redesign: Serial Device and Philips Hue split into separate cards with compact connect bar, status indicator dots, and per-port connection badges
- Control page output targets redesigned as compact chip-style toggles showing live device availability
- Hue stepper redesigned with numbered steps (✓ / active / inactive) and network unreachable hint
- Dark mode badge color improvements in Device section (Connected, Checking, Unreachable badges)
- Expanded `README.md` with setup, scripts, structure, and policy references

### Fixed

- DTLS thread death no longer causes silent stuck-`Running` state — fault is registered and UI reflects failure
- Race condition in `start_hue_stream`: concurrent stop during async credential fetch no longer spawns a dangling sender
- `stop_hue_stream` timeout branch was unreachable (always called with `timed_out=false`) — now properly triggered via `ShutdownSignal`
- `persistent_sender` not cleared on user-initiated stop — fixed to prevent ghost connections
- Serial port handle leak on disconnect: `disconnect_session` now called on `LedPacketSender` to release the port
- Phantom `DISCONNECT_PORT` contract entry removed from `device.ts` (command never existed in Rust)
- CSP in `tauri.conf.json` changed from `null` to a strict policy
- Hue solid color not pushed on app startup when restoring a persisted solid mode
- `Cargo.toml` version aligned to `1.0.2` (was `0.1.0`), fixing auto-updater version detection
- `Cargo.toml` author placeholder replaced with real value

---

## [1.0.2] — 2026-03-26

### Fixed

- Release pipeline validation: aligned CI artifact naming and signature verification steps
- `reqwest` dependency upgraded to resolve upstream security advisory

---

## [1.0.1] — 2026-03-26

### Added

- Philips Hue entertainment area streaming (DTLS, CLIP v2)
- Hue channel-to-screen-region mapping with per-channel override UI
- Hue bridge discovery, pairing, and credential validation flow
- `get_hue_stream_status` runtime polling with fault-aware reconnect
- Hue solid color push via `set_hue_solid_color` command
- Output target selection (USB / Hue / both) persisted across sessions
- Display enumeration and overlay support for multi-monitor calibration
- DPI correction and fallback logic for display capture

### Changed

- Settings redesigned into Control / Calibration / Settings navigation
- Device section migrated to contract-first design (`device.ts`, `hue.ts`, `shell.ts`)
- Hue commands refactored to `async/await` for improved responsiveness

### Fixed

- CI: added `libudev` dependencies on Linux runners
- Calibration auto-open flag preserved across page refreshes via `sessionStorage`

---

## [1.0.0] — 2026-03-21

### Added

- Tray-first shell: single window hidden to tray on close, reopen via tray icon
- USB serial device discovery with CH340 / FTDI chip support
- Connection resilience: auto-reconnect loop with health check pipeline
- LED calibration editor: template selection, edge counts, gap, corner ownership, start anchor, direction
- Lighting modes: Off, Ambilight (screen capture), Solid (RGB + brightness)
- Ambilight: real-time screen capture at up to 60 Hz with runtime quality controller
- Solid: color picker and brightness slider with debounced 50 ms push
- Runtime telemetry: FPS, frame drops, capture errors displayed in Diagnostics tab
- EN / TR localization with automatic locale parity test
- Auto-updater: GitHub Releases with minisign signature verification
- Startup launch-at-login toggle
- QUAL-04 60-minute stability gate passed
