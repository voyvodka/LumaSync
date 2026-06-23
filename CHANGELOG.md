# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog:
https://keepachangelog.com/en/1.1.0/

## [Unreleased]

### Added

- Hue active-streamer banner now clears on its own: while an entertainment area is held by another active streamer, readiness is re-probed every 3 s (instead of the 15 s healthy cadence) and the banner dismisses within ~3 s of the foreign session releasing — no manual revalidate needed.
- `HUE_STOP_TIMEOUT_PARTIAL` runtime faults now surface a "Retry Stop" action hint, matching the inline recovery CTA in the device panel.

### Changed

- Hot-path Rust→JS events (60 Hz edge signals, tray/shell lifecycle) are emitted to the main settings webview only, so calibration-overlay windows are no longer woken on every frame — lower idle CPU whenever an overlay window exists.
- Hue background readiness refresh migrated from a fixed `setInterval` to a visibility-aware recursive `setTimeout`, pausing while the window is hidden and re-arming on focus, consistent with the rest of the polling discipline.
- RoomMap template selector migrated to the amber Rev 07 design tokens.

### Security

- Resolved RUSTSEC-2026-0185 (7.5 high) by bumping the transitive `quinn-proto` dependency to 0.11.15; `memmap2` bumped to 0.9.11 (RUSTSEC-2026-0186). The `cargo audit` CI gate is green again.

## [1.5.2] — 2026-05-05

### Added

- Keyboard input for per-edge LED counts and stand-gap in LED Setup, allowing direct numeric entry instead of stepper-only interaction.
- First close-to-tray OS notification guides new users who wonder where the app went after closing the window.
- Frontend `console.*` calls are now bridged to `tauri-plugin-log`'s file sink, so `[webview]` records appear alongside Rust log entries in the platform log file — runtime debugging no longer requires an open DevTools window.

### Changed

- Polling discipline tightened across telemetry and Hue health checks: all intervals pause when the window is hidden and resume on visibility, reducing CPU and battery draw when LumaSync is running in the background.
- Boot sequence streamlined: Hue credential validation is de-duplicated (previously fired twice on some paths) and the updater check is hoisted to run earlier, so the first-launch experience is snappier.
- RoomMap editor migrated to amber Rev 07 design tokens with a 32 px minimum tap-target floor throughout the dock and toolbar.
- Compact-mode deep-links to non-LIGHTS sections now auto-expand to full-window mode so the target panel is always visible.
- Window position persistence anchored by window center instead of top-left corner, with a monitor-clamp guard that snaps the window on-screen if the saved position falls outside the current display geometry.
- Release pipeline (`release.yml`) now runs the same Rust hardening gate as `ci.yml` before any tag-triggered build — `cargo fmt --check`, `cargo clippy -D warnings`, `cargo test --all-features` — closing the gap that previously let lint regressions or integration-test failures slip through to a release artefact.
- CI: `pnpm/action-setup` bumped v4 → v6 to clear the Node 20 deprecation warning; workflow concurrency and release idempotency (`allowUpdates`) tightened.
- Rust deps: `mdns-sd` 0.13.11 → 0.19.1 (major); `ResolvedService` surface adapted in the mDNS registry; Cargo.lock transitive graph refreshed on the 2.11.x Tauri line.

### Fixed

- macOS lifecycle hardened: Cmd+Q, tray Quit, and Ctrl+C now all route through a single `kick_off_shutdown_and_die` path. Two follow-up regressions from the initial rewrite are resolved — the `tauri-plugin-single-instance` socket is no longer leaked on watchdog exit (which caused the next dev launch to exit within ~50 ms), and `stop_hue_stream` is detached onto a worker thread with a 1.5 s abandon timeout so it cannot blow the 4 s watchdog.
- macOS tray icon now ships as a template image (monochrome silhouette), so it renders at the correct size and respects Dark/Light menu bar mode.
- Non-USB serial port types (Bluetooth, PCI, Unknown) are rejected with `PORT_UNSUPPORTED` before `serialport::open()` is called. Previously, opening `/dev/cu.Bluetooth-Incoming-Port` silently accepted writes while the LED strip stayed dark.
- Boot output-target recovery: persisted empty `[]` targets are no longer overwritten with defaults on every launch; the `PORT_UNSUPPORTED` subscriber auto-adds Hue when a bridge is paired and Hue was not already active; a separate boot path prevents paired-Hue-only users from being stranded in OFF state on restart.
- WLED backend–frontend wire mismatch: request/response payload shapes for discover, connect, and test were misaligned, causing the picker to render empty and the Connect/Test buttons to fail with `MissingField`. All three command pairs are now aligned; `WledTestResponse` reports a real round-trip in milliseconds.
- WLED: additional validation rejects `led_count == 0` at connect time (`WLED_INVALID_LED_COUNT`) and extends the SSRF guard to also block loopback, unspecified, multicast, and broadcast addresses (`WLED_INVALID_IP`).
- Output-target delta-stop no longer evicts a chip from active membership when the underlying stop call fails — the chip stays active so the user can retry, and a transient banner identifies which target needs attention.
- Hue stream shutdown emits a DTLS `close_notify` alert and de-dupes foreground/background deactivate calls via a single-shot atomic token, so the bridge clears its "active streamer" slot immediately and the latent `HUE_STREAM_NOT_READY_ACTIVE_STREAMER` 403 on the next session start is eliminated.
- RoomMap rename dialog: ESC now cancels from any focused element; Tab cycles input → cancel → confirm; `aria-labelledby` IDs are generated with `useId()` to prevent DOM collisions on re-mount.

### Security

- WLED IP validation extended: loopback (127.0.0.0/8), unspecified, multicast, and broadcast addresses are now rejected with `WLED_INVALID_IP`, layered on top of v1.5.1's parser-level SSRF guard.

## [1.5.1] — 2026-05-01

### Security

- Bump `rand` 0.8.5 → 0.8.6 and `rand` 0.9.2 → 0.9.4 to clear RUSTSEC-2026-0097 (unsoundness with a custom logger using `rand::rng()`); both reach LumaSync transitively through `tauri-plugin-notification` and `xcap`. The remaining `glib 0.18.5` Linux-runtime warning (RUSTSEC-2024-0429) requires a Tauri/gtk major bump and is tracked for v1.6.

### Changed

- Rust deps: Tauri 2.10.3 → 2.11.0 (and the matching `tauri-build`, `tray-icon`, `wry` chain), `reqwest` 0.13.2 → 0.13.3 (Dependabot minor-and-patch group).
- Frontend deps: `@tauri-apps/api` and `@tauri-apps/cli` 2.10.1 → 2.11.0, `jsdom` 29.1.0 → 29.1.1 (Dependabot minor-and-patch group).

## [1.5.0] — 2026-04-28

### Added

- Hue Zone system: entertainment areas now map to logical zones with zone-relative coordinates, AR-locked size slider, center/border color picker, and a live zone bounds visual on the room map canvas — zones render simultaneously with individual show/hide toggles
- HSV color picker: hue/saturation/value wheel replaces the flat RGB swatch in the Hue zone inspector, with a portal-aware popover that escapes compact-mode clipping
- WLED DDP bridge: UDP discovery (`_wled._tcp.local.` via mDNS), connect, and test-pattern flow; WLED appears as a first-class output target alongside USB and Hue
- Linux X11 screen capture via xcap — LumaSync now ships on all three desktop platforms (macOS, Windows, Linux)
- SK6812 RGBW host-side encoder: white channel derived as `W = min(R, G, B)` extraction, chip type persisted per device; selector exposed in device settings
- Expanded USB VID/PID allowlist: PL2303, CH341, CP2104 (Silicon Labs CP2102), and FT232H added alongside the existing CH340 and FT232R entries
- Hue per-bulb gamut clip: `gamut_type` (A/B/C) is fetched per light during area activation and applied in the DTLS frame builder hot-path with luminance-preserving xy→RGB mapping
- Hue OS keychain credential migration: bridge username and PSK are moved from plaintext `shellStore` to the platform keychain (macOS Keychain, Windows CredMan, Linux Secret Service) with an idempotent, downgrade-safe migration path
- mDNS bridge discovery: Hue bridges are discovered via `_hue._tcp.local.` with cloud API as fallback; shared mDNS responder also serves the WLED browser to avoid `SO_REUSEPORT` contention on macOS
- First-run onboarding banner: three-step progressive inline flow guides new users from device pairing through first Ambilight activation; dismissed permanently after completion
- Offline USB strip reconnect affordance: a reconnect button appears when a paired strip's port is unavailable on launch, replacing the silent failure path
- Beta update channel scaffold: `updateChannel` shell state lets opted-in users receive pre-release builds via a separate `latest-beta.json` endpoint; stable channel behavior unchanged
- Windows hardware-accelerated downscale scaffold: frame builder wired to accept a downscale hint for the Windows capture path (full implementation follows in a subsequent patch)
- RoomMap editor full rework: tabbed dock with type-aware inspector dispatcher (USB strip / Hue zone / furniture / TV anchor), amber Rev 07 chrome throughout, multi-strip pair-as-strip flow, port change on paired strips via inline dropdown, and all Hue zones rendered simultaneously on the canvas

### Changed

- Hue zone identity collapsed onto `borderColor`; `HueZone` type unified into a `Zone` discriminated union (`zoneType` field) under the `room_map` module — schema version migrated 1→2 with an automatic shim so existing room maps open without data loss
- RoomMap editor canvas drag-and-drop now works correctly in WKWebView; Hue channel drags clamp to the bound zone regardless of selection state
- Lighting mode bootstrap reworked: ambilight state hydrated from persisted config on cold start (USB-only path); saturation and smoothing alpha preserved across brightness-only fast-path tweaks
- Serial connect and health-check now unblock the IPC dispatcher during the operation, eliminating UI freezes on slow port enumeration
- USB serial auto-reconnect broadcasts connection events with a structured lifecycle so the UI reacts without polling
- Compact mode ambilight brightness and smoothing controls mirrored into full settings for parity; Adalight brightness lock applied in compact mode
- App icon body inset to 720×720 to match the macOS dock squircle visual weight
- Rust deps: `keyring` 3.x and `mdns-sd` 0.13 added; `tokio` held at 1.52.1
- Frontend deps: i18next, jsdom, vite bumped (patch/minor); no breaking changes
- GitHub Actions: Linux runner bumped from ubuntu-22.04 to ubuntu-24.04 across CI and release workflows; `libgbm-dev` added to apt deps for xcap linker

### Fixed

- Latent DTR auto-reset: 2-second bootloader settle delay added after DTR toggle so firmware has time to initialize before the first frame
- Ambilight cold-start: persisted ambilight profile now hydrates correctly when the app launches directly into ambilight mode without a prior UI interaction
- Hue color flash on stream start and dim-on-saturated artifact: color correction order aligned so the first frame does not briefly push an unintended hue
- USB auto-pair race: connection state gate added so a rapid disconnect/reconnect sequence no longer leaves the port handle in a leaked state
- Adalight firmware profile picker: brightness lock override now correctly applies in compact mode matching full-settings behavior
- `InspectorNumberField` re-edit: committing a value with Enter no longer locks the field into read-only display until blur
- LED setup canvas: arrow direction and start-anchor visualization now match the backend canonical traversal under both CW and CCW, including all eight corner anchors and the bottom-gap variants
- LED setup cold-start: persisted display selection now derives default per-edge LED counts on launch instead of leaving the editor at 0/0/0/0 until a manual monitor change
- Calibration overlay refresh race: opening the overlay after a frontend refresh no longer fails with `OVERLAY_WINDOW_OPEN_FAILED` from a stale Tauri window-label registry entry
- First-run onboarding banner: persisted lighting mode now primes the LIGHTS step guard on cold start so returning users skip the gating ribbon
- RoomMapEditor mousemove listener thrashing: pan/zoom interactions no longer detach and re-attach the canvas listener every frame

## [1.4.0] — 2026-04-24

### Added

- USB per-LED sampling: each LED now samples its own edge region of the screen (anchored to the room map's edge counts, start anchor, direction, and bottom gap), replacing the single-zone hardcode shipped in v1.3; baud budget adapts dynamically so 60 LEDs run at ~60 FPS and 200 LEDs at ~19 FPS within the 115200 baud limit
- LedSink trait: a common `start / send_frame / stop` abstraction over the serial output bridge, laying the foundation for WLED (v1.5) and OpenRGB (v2.0) sinks
- Multi-monitor capture: stable display IDs on macOS (SCDisplay) and Windows (device_name) with automatic primary-display fallback on unplug; selected display persists across restarts
- Per-channel color correction: independent R/G/B gamma tables, Kelvin white-balance multipliers, and BT.601-luminance saturation trim — tuned once per strip, applied on the hot path before smoothing so USB, Hue, and the edge-signal preview stay visually consistent
- Adalight firmware profile: encoder dispatch selects between LumaSync-native framing (default) and the widely-used Adalight `"Ada"` header format; profile is persisted per device
- Serial handshake round-trip: PING/PONG opcode protocol with `SerialHealthReport` and coded `SerialHealthCode` status; firmware implementation ships in the companion hardware repo's v1.5 update
- Platform notifications: `tauri-plugin-notification` + `tauri-plugin-process` wired end-to-end; permission banner asks once, OS-level toasts for connection, stream, and update events; `open_log_dir` command exposes the app log directory
- FPS/latency HUD: StatusBar fourth pill shows live frame rate and end-to-end latency with green/amber/red thresholds (45/25 FPS); always visible while Ambilight is active
- Global ErrorBoundary: catches render faults and surfaces a localized fallback card with Show logs, Restart, and Copy error actions instead of a blank tray window
- Keyboard shortcuts: `Alt+1/2/3` (Ctrl on Windows/Linux) to switch modes, `Alt+,` / `Cmd+,` to open Settings; TR-layout-safe key resolution with input-focus guard
- Hue richer pairing errors: CLIP `error.type` is now split into `LINK_BUTTON_NOT_PRESSED`, `DEVICETYPE_INVALID`, `BRIDGE_BUSY`, and `RATE_LIMITED` — each surfaces a distinct localized message
- Hue room archetype enrichment: entertainment area list fetches CLIP v2 archetype data in parallel (`tokio::join!`) and surfaces it in the area-select UI
- Hue intensity presets: Subtle (EWMA 0.15) / Moderate (0.35) / Intense (0.60) coefficient shortcuts for fast ambience tuning

### Changed

- CI hardening: 3-OS matrix (ubuntu-22.04, macos-latest, windows-latest) with `cargo fmt --check`, `cargo clippy -D warnings`, `cargo check --all-targets --all-features`, `cargo test --no-run`, and `cargo audit` on Linux; CodeQL JavaScript/TypeScript scanning on push, PR, and weekly schedule; `dependency-review-action` with MIT/Apache/BSD/ISC allow-list on PRs
- Rust toolchain pinned to stable via `rust-toolchain.toml` with `rustfmt` and `clippy` components
- Node.js bumped from 20 to 22 across CI and release workflows
- Log rotation set to 5 MB (KeepOne in release builds, KeepAll in debug)
- Hue 403 re-pair contract tightened: only a 403 with CLIP `type == 1` triggers re-pair; other 403 responses are treated as transient and do not interrupt the session
- Lighting responsiveness unified: the continuous smoothing slider and the Hue-only intensity preset merged into a single three-step control (Subtle / Moderate / Intense) that drives both USB and Hue EWMA paths at once; legacy persisted state (`smoothingAlpha`, `hueIntensityPreset`) still reads through a fallback chain so no migration is required
- Hue pipeline now applies the full color-correction chain (gamma + Kelvin + saturation), matching the USB encoder order byte-for-byte so strip and bulbs stay visually consistent
- Rust deps: reqwest rustls chain updated (aws-lc-sys 0.37 → 0.40, rustls-webpki 0.103.10 → 0.103.13, rustls 0.23.37 → 0.23.39)
- Frontend deps: `@tauri-apps/plugin-notification` and `@tauri-apps/plugin-process` added; minor/patch bumps across the React/Vite/Vitest ecosystem
- GitHub Actions: `actions/checkout` and `actions/setup-node` pinned; `pnpm/action-setup` held at v4 with pnpm 10 explicit pin

### Fixed

- Silent `try/catch` purge: 7 swallowed errors in `App.tsx` and `SystemSection` now route through the structured logger with contextual prefixes
- Preexisting Rust test bitrot: `hue_onboarding_tdd` fixtures and `ambilight_capture` import blocks had drifted from the current module layout; fixed so `cargo test` compiles cleanly in CI
- 14 clippy pedantic lint warnings resolved as a baseline cleanup pass
- Ambilight settings persistence: pending `lightingMode` writes are now flushed on `pagehide` and `visibilitychange`, so saturation and black-border toggles survive Cmd+R / tray close / reload cycles
- Color correction + firmware profile payload: the mode normalizer now preserves these fields end-to-end instead of stripping them before `set_lighting_mode` invoke, so slider commits actually reach the worker

### Removed

- 5 orphan settings components absorbed by M6: `LanguageSection`, `StartupTraySection`, `AboutLogsSection`, `CalibrationSection`, `ConfigurePage` — along with 2 orphan test files
- `SidebarFpsWidget` retired; the StatusBar FPS/latency pill supersedes it

### Security

- CodeQL JavaScript/TypeScript scanning added to CI (push, PR, and weekly Monday schedule)
- `dependency-review-action` gates PRs on license allow-list (MIT/Apache/BSD/ISC) and blocks high-severity CVEs
- `cargo audit` runs on Linux CI step; 8 transitive RUSTSEC advisories resolved by bumping the reqwest/rustls chain

## [1.3.1] — 2026-04-23

### Fixed

- CHANGELOG: de-duplicated `[1.1.0]` heading; the March 2026 foundation entry was never tagged and is now demoted to a historical sub-section so the release workflow's changelog extractor no longer silently drops it

## [1.3.0] — 2026-04-22

### Added

- Compact UI mode with dual-sized window (compact 320×480 / full 900×620), custom overlay title bar, and accent theme system driven by a new `UIMode` contract
- CompactLayout view with quick-access mode presets, scene tiles, and integrated mode toggle for a tray-style experience
- LightsSection redesign (M6): mode selector, scene presets, ambilight profile sliders, and live device/status visualisation
- StatusBar with mode, device, and stream indicators alongside the new shell chrome
- UpdateModal rewrite covering four states (available / downloading / installing / error) with i18n-backed labels
- Hue Bridges section redesign (B-08): card state classes, pill variants, traffic bar label row, four-step pairing tracker with failure state, area-select label, conflict/repair/offline banners, and action buttons aligned to all 17 defined states
- Edge signal preview panel: the ambilight worker now emits a throttled `ambilight://edge-signal` Tauri event (~10 Hz) with top/bottom/left/right RGB samples, rendered as live linear gradients next to a primary-display tile
- Runtime telemetry meta pill showing live `Δ` frame latency and `Σ` FPS sourced from `get_runtime_telemetry` while Ambilight is active; polling pauses when the tab is hidden
- Ambilight saturation control: luminance-preserving Rec.601 factor (range 0.5–2.0, identity 1.0) stored as an `AtomicU32` in the worker's live settings, applied on the hot path before smoothing so USB LEDs, Hue channels, and the edge-signal preview stay visually consistent; exposed in Lights as a 50–200% dial
- Unified scene preset catalog (`src/features/mode/model/scenePresets.ts`) with a `brightness` field, shared by Compact and Lights; active preset is derived from the current SOLID payload so selection survives view switches and app restarts
- Dock "+" add-zone affordance rendered as disabled with a tooltip, surfacing multi-zone support as a known-future feature
- `EdgeSignalPayload` / `EDGE_SIGNAL_EVENT` exported from the mode contract module for typed event wiring
- Jules agent documentation: hard constraints, security rules, and architecture data-flow map to guide automated security/performance scans
- `LedRoomCanvas`: read-only SVG illustration of the monitor + desk scene with LED dots distributed per edge, a #1 start marker, and a direction arrow — driven purely from `LedCalibrationConfig`
- `deriveDefaultCounts(display)`: frontend heuristic that assigns sensible per-edge LED counts from monitor resolution and aspect ratio so auto-selected displays fill the canvas on first run without a template picker

### Changed

- Compact/full UI mode transition now uses a single content slot with sequential fade + resize + fade and easing matched to the window animation, eliminating the progressive-clipping artefact where the incoming layout overflowed the still-animating window
- Removed the orange edge-sweep animation from window mode transitions; the simpler fade + resize flow remains
- LED Setup redesigned to a single-screen stage + 268px dock layout: the three-step display/template/editor wizard, template picker, and draggable editor canvas are gone; counts are adjusted directly in the dock and the test pattern runs in place with a preview/output HUD overlay on the canvas
- LED Setup dock exposes the full strip topology: partial-edge setups (e.g. LEDs only on the top) are allowed (0-count edges), monitor stand gap (`bottomMissing`) has a dedicated stepper, LED direction toggles between CW / CCW, and start anchor is driven by edge tabs + Start/End/Gap-R/Gap-L endpoint buttons so all 10 `LedStartAnchor` positions are reachable. `LedRoomCanvas` now renders the stand gap and places the `#1` marker on the gap-adjacent LED for `bottom-gap-*` anchors
- Calibration validation: 0-count edges are now accepted as long as `sum > 0` (`NO_LEDS_CONFIGURED`); stand gap wider than the bottom edge now fails with `BOTTOM_MISSING_EXCEEDS_BOTTOM`; `normalizeLedCalibrationConfig` auto-clamps `bottomMissing` to bottom count and auto-heals `startAnchor` when its edge is zeroed out
- Hue stream health polling migrated from `setInterval` to recursive `setTimeout`, preventing overlapping probes when a health check takes longer than its interval and stopping polling as soon as the stream is detected dead
- Internationalisation sweep: DeviceSection cell labels (Area, Protocol, Ch, Rate, Status, Error, Retries, Next, Fault, Config, Credential, Invalid), traffic bar Stream label, DTLS streaming subtitle, display card ID/Scale labels, previously-missing wizard step keys, UpdateModal note kind tags moved to `updater.noteKind.*`, RenameDialog Cancel/OK buttons in RoomMapEditor, and StatusBar keyboard hint labels (mode / settings) — EN + TR locales kept in sync
- Test layout: all colocated `*.test.ts(x)` files relocated into `__tests__/` subdirectories and CLAUDE.md updated to document the convention
- Rust dependencies bumped: `tokio` 1.50.0 → 1.52.1, `openssl` 0.10.76 → 0.10.78
- Frontend dependencies bumped (minor/patch): `i18next` 26.0.4 → 26.0.6, `react-i18next` 17.0.2 → 17.0.4, `tailwindcss` + `@tailwindcss/vite` 4.2.2 → 4.2.4, `typescript` 6.0.2 → 6.0.3, `vite` 8.0.8 → 8.0.9, `vitest` 4.1.4 → 4.1.5, `happy-dom` + `@happy-dom/global-registrator` 20.8.9 → 20.9.0
- GitHub Actions bumped: `actions/checkout` 4 → 6, `actions/setup-node` 4 → 6, `pnpm/action-setup` 4 → 6
- Dependabot configuration added for Cargo, npm, and GitHub Actions ecosystems so future dependency updates land as reviewable PRs
- Linux CI hardened with `DEBIAN_FRONTEND=noninteractive` to prevent apt-get prompts from hanging the runner
- `.gitignore` now ignores `.planning/` and `.jules/` recursively so local planning artefacts never leak into status
- Removed legacy `.jules` tracking files from the repository

### Fixed

- Hue stream polling overlapping probes when a health check ran longer than the interval (migrated to recursive `setTimeout`)
- DeviceSection and SettingsLayout test suites updated for the b06 redesign markup
- LightsSection test suite: added a `Trans` mock so rich-text i18n fragments render deterministically in jsdom
- Removed unused imports that were failing `tsc --noEmit` with TS6133 after recent refactors
- Hardcoded fallback strings in Device and Updater UIs replaced with `t()` keys so EN/TR locales render consistently

### Performance

- RoomMapEditor: isolated high-frequency mouse-coordinate state into a dedicated child that uses native DOM listeners with `requestAnimationFrame` throttling, eliminating full-editor re-renders on cursor movement
- SettingsLayout: wrapped in `React.memo` to prevent polling-triggered re-renders of the entire settings tree

### Known Limitations

- USB output is single-zone: the ambilight worker currently samples one pixel and sends a single RGB triplet per frame to the controller, which the companion firmware extends across the full strip. Per-edge position sampling driven by `LedCalibrationConfig` (edge counts, start anchor, direction, bottom gap) is planned for v1.4; the calibration UI still records and persists the full layout so the Hue channel path and future USB wiring stay consistent.
- The USB serial frame format is LumaSync-specific (`0xAA 0x55` header, LE LED count, gamma-corrected RGB, XOR checksum) — earlier documentation referred to this as "Adalight-compatible", which it is not.

## [1.2.0] — 2026-04-10

### Added

- Room map editor: undo/redo with Cmd+Z / Cmd+Shift+Z (max 50 steps)
- Room map editor: collapsible object list panel (right sidebar) with grouped objects and inline rename
- Room map editor: smart snap alignment guides (edge/center) during drag operations
- Room map editor: origin crosshair marker with snap-to-center
- Room map editor: right-click context menu (duplicate, delete, lock, z-order, rename, rotate)
- Room map editor: property bar with numeric x/y/w/h/rotation inputs for precise positioning
- Room map editor: extended keyboard shortcuts (Cmd+D duplicate, Shift+Arrow 10x nudge, L lock, [ ] z-order)
- Room map editor: scroll wheel zoom (0.5x–3x) with mouse-centered scaling and Cmd+0 fit-to-view
- Room map editor: space+drag and middle-mouse pan navigation
- Room map editor: real-time mouse coordinate display in meters
- Room map editor: template system with presets (TV 55", L-desk, full room, blank canvas)
- Room map editor: multi-image background layers with per-layer opacity, lock, and reorder
- Room map editor: universal object lock and resize handles for all object types
- Room map editor: floating left toolbar replacing fixed top toolbar

### Fixed

- Room map editor: rotated furniture resize now uses anchor-based positioning for correct behavior

## [1.1.1] — 2026-04-09

### Fixed

- Windows: calibration overlay close event no longer intercepted by the close-to-tray handler (overlay was preventing app quit)
- Windows: overlay positioning now uses display's scale factor instead of window's runtime scale factor, fixing placement on DPI-scaled monitors
- Windows: WebView2 child windows now receive `WS_EX_TRANSPARENT | WS_EX_LAYERED` so the overlay is truly click-through and does not block mouse events behind it

## [1.1.0] — 2026-04-09

### Added

- Ambilight: black border detection to crop letterbox bars before color sampling
- Ambilight: user-configurable color transition speed (smoothing alpha) in settings
- Tray: quick-action menu items (Lights Off, Resume Last Mode, Solid Color) with i18n label support
- CI: universal macOS binary (x86_64 + arm64) support in release workflow
- Debug: sidebar FPS widget in development builds

### Changed

- Hue: per-channel EWMA smoothing and continuous position sampling for smoother color transitions
- App version now resolved dynamically from the build instead of a hardcoded string
- macOS deployment target set to 12.3 for SCStream compatibility

### Fixed

- WS2812B output: apply gamma 2.2 correction for accurate perceived brightness
- Ambilight UI: reflect mode state correctly in UI on transient Hue failure
- Hue telemetry: fix stream state reporting after per-channel smoothing refactor
- Tests: fix 2 failing unit tests and resolve 12 unhandled rejections in App test suite
- SCStream: fix log timestamp formatting and release crash on session stop

## [1.0.4] — 2026-04-09

### Changed

- Migrated package manager from Yarn Classic (1.x) to pnpm 10; updated all scripts, CI/CD workflows, docs, and `tauri.conf.json`
- SECURITY.md: updated supported versions table from `0.1.x` to `1.0.x` and added private vulnerability reporting link
- README.md: added CI, Release, License, and Platform badges; added Platform Support table (macOS / Windows / Linux)
- CONTRIBUTING.md: commit examples updated with scope prefixes; added fork workflow and review process sections
- CODE_OF_CONDUCT.md: added GitHub private vulnerability reporting as a confidential report channel

### Fixed

- Release workflow (`release.yml`): added `typecheck`, `verify:shell-contracts`, and `vitest run` validation steps before build
- CI workflow (`ci.yml`): added `vitest run` step for frontend test coverage
- CHANGELOG.md: removed stale separator under `[Unreleased]`

### Added

- `.github/ISSUE_TEMPLATE/config.yml`: issue template chooser with security advisory link and blank issue restriction
- CLAUDE.md: added Code Style, Verification Flow sections; consolidated with AGENTS.md as single source of truth
- AGENTS.md: rewritten as thin reference to CLAUDE.md with agent-specific behavioral rules only

### Fixed (tests)

- `App.test.tsx`: fixed mode orchestration tests for updated output target and Hue gate behavior
- `manualConnectFlow.test.ts`: fixed auto-scan, stale selection, remembered port, and refresh throttle tests
- `useHueOnboarding.runtime.test.ts`: fixed retry pipeline routing test
- `GeneralSection.test.tsx`: fixed solid payload color change test
- `useRoomMapPersist.test.ts`: fixed resetConfig default room map test

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

### Historical — Pre-1.1.0 Foundation (2026-03-28)

#### Added

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

#### Changed

- `stop_with_timeout` now clears `persistent_sender` on user-initiated stops (`ModeControl`, `DeviceSurface`) and preserves it on system-triggered stops
- `start_hue_stream` guards against race condition: re-checks `owner.state` after async credential fetch before storing stream context
- `App.tsx` polls `get_hue_stream_status` every 5 s when Hue is active; removes "hue" from `activeOutputTargets` when backend reports `Failed` or `Idle`
- Device Settings redesign: Serial Device and Philips Hue split into separate cards with compact connect bar, status indicator dots, and per-port connection badges
- Control page output targets redesigned as compact chip-style toggles showing live device availability
- Hue stepper redesigned with numbered steps (✓ / active / inactive) and network unreachable hint
- Dark mode badge color improvements in Device section (Connected, Checking, Unreachable badges)
- Expanded `README.md` with setup, scripts, structure, and policy references

#### Fixed

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
