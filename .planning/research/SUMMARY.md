# Project Research Summary

**Project:** LumaSync v1.2 — Room Visualization and Universal Light Management
**Domain:** Tauri 2 + React 19 desktop app — 2D room map editor, Hue channel position editor, LED zone auto-derivation, Hue standalone mode
**Researched:** 2026-03-30
**Confidence:** MEDIUM-HIGH

## Executive Summary

LumaSync v1.2 adds four interconnected capability areas on top of a stable v1.1 foundation: a 2D room map canvas (light source placement), a Hue channel position editor (CLIP v2 read/write), LED zone auto-derivation (room map geometry to calibration config), and Hue standalone mode (USB-free operation). The research is unusually strong for architecture because it is grounded in direct codebase analysis of the existing LumaSync source, not external inference. The stack additions are minimal: react-konva + konva for the canvas, zustand for in-memory room map state during editing, and no new Rust crates. All Hue channel position HTTP I/O reuses the existing `reqwest`-based `hue_http_client()` helper already in production.

The recommended build order follows hard dependency chains discovered in the architecture research: contracts first (every cross-boundary type must be defined before implementation), then HUE-08 fault recovery (clears v1.1 debt and stabilizes the runtime that standalone mode depends on), then the Hue channel position editor and room map editor (independent of each other), then standalone mode (requires stable fault recovery), then LED zone derivation (requires the room map data model to be stable), and finally UX polish (HUX-01/02). Violating this order creates rework — particularly building standalone mode before fault recovery produces a broken first-run experience for Hue-only users.

The dominant risk cluster is "data model boundary confusion": room map state, Hue channel positions (bridge-authoritative), LED calibration config, and user overrides each have different ownership, persistence, and mutation semantics. Conflating them leads to silent data loss, accidental bridge mutation, and calibration profiles being overwritten by zone derivation. Every phase must treat these as distinct models with explicit derivation steps and user confirmation gates rather than unified shared state. The secondary risk is WebView2 GPU acceleration: the `--ignore-gpu-blocklist` flag must be set in `main.rs` before canvas drag work begins, or Windows-specific jank will appear only after significant canvas code has been written.

---

## Key Findings

### Recommended Stack

The base LumaSync stack (Tauri 2, React 19, TypeScript strict, Tailwind 4, i18next, plugin-store, reqwest, serialport, tauri-plugin-log) requires no changes. Three new frontend packages are added: `react-konva@^19.2.3` and `konva@^10.2.3` for the 2D canvas editor, and `zustand@^5.0.12` for in-memory room map state during active editing sessions. No new Rust crates are required — channel position writes use the existing `hue_http_client()` pattern from `hue_onboarding.rs`. LED zone derivation is approximately 40-60 lines of pure TypeScript bounding-box math in a new `roomToScreenEdge.ts` utility, with no geometry library dependency.

**Core technologies (new additions):**
- `react-konva@^19.2.3` + `konva@^10.2.3`: 2D interactive room map canvas — drag/drop, hit detection, transformer handles — React 19 version-aligned. Chosen over React Flow (node-graph semantics, wrong abstraction), Fabric.js (stale React 19 bindings), and D3 (SVG-imperative model conflicts with React reconciler).
- `zustand@^5.0.12`: In-memory room map store during editing. Flat store model suits cohesive room map updates (moving a light triggers zone recomputation across the whole map). Does NOT replace plugin-store — flushed to plugin-store on save events only.
- `hue_http_client()` (existing): Channel position PUT reuses the same reqwest helper used by `list_hue_entertainment_areas` and `pair_hue_bridge`. No new HTTP infrastructure.

**Critical version constraint:** react-konva 19.x ONLY supports React 19. Do not install react-konva 18.x or zustand v4.

### Expected Features

The v1.2 feature set divides cleanly into a launch-required core (P1) and a post-core validation layer (P2). The MVP definition from FEATURES.md is the authoritative list for scope control.

**Must have (table stakes — v1.2 launch):**
- 2D room map: drag-drop placement of TV, LED strip, and Hue channels on a shared canvas — users expect this from SmartThings Map View / Govee DreamView precedents
- Room map persisted across sessions — no persistence = no value
- Hue channel positions read from CLIP v2 with screen region labels (left/right/top/bottom/center) derived from xyz coordinates
- USB-free app startup — Hue-only users must not see USB error states
- HUE-08 automatic DTLS fault recovery — eliminates the "restart app to recover" workaround
- HUX-01: Hue stream status visible in Device settings surface
- HUX-02: Output target switching (USB / Hue / both) without losing mode state
- HDR-01: Hue error codes shown with user-readable explanations and action hints
- HDR-02: Hue stream health metrics in the telemetry panel

**Should have (competitive differentiators — post-core v1.2.x):**
- LED zone auto-derivation from room map geometry with user confirmation step — Hyperion/HyperHDR still require full manual configuration
- Hue channel positions written back to bridge (optional "Save to Bridge" explicit action)
- Room map-derived Hue channel xyz position suggestion with user confirmation flow

**Defer (v2+):**
- Multi-room / multi-monitor room maps
- Room map PNG/SVG export
- Physical room dimensions with accurate scale
- Automatic USB-to-Hue failover

### Architecture Approach

The architecture research is HIGH confidence because it is derived from direct codebase analysis. The existing contract-first pattern (all types defined in `src/shared/contracts/` before implementation, enforced by `yarn verify:shell-contracts`) is the organizing principle for all v1.2 additions. The room map state lives entirely in the frontend (`roomMapStore.ts` + `ShellState.roomMap` in plugin-store) with no new Rust state. The Hue channel write path adds one new Rust command (`update_hue_channel_positions` in `hue_onboarding.rs` — not `hue_stream_lifecycle.rs`). LED zone derivation is a pure TypeScript function (`zoneDerivation.ts`) with no Tauri calls. Standalone mode has the widest blast radius: it modifies `modeGuard.ts`, `OutputTargetsPanel.tsx`, and the `SetLightingModeRequest` struct in `lighting_mode.rs`.

**Major new components:**
1. `src/features/roomMap/` — New feature module: `contracts.ts` (model), `roomMapStore.ts` (state + persistence), `zoneDerivation.ts` (pure derivation), `RoomMapEditor.tsx` + `LightSourceDot.tsx` (canvas UI)
2. `src/shared/contracts/roomMap.ts` — New contract file: `RoomMapConfig`, `LightSourcePlacement`, `RoomDimensions` types
3. `update_hue_channel_positions` (Rust) — New command in `hue_onboarding.rs`; invalidates `HueRuntimeStateStore` channel cache after successful PUT
4. `canEnableHueStandaloneMode()` — New guard function in `modeGuard.ts`; routes mode activation based on `outputTargets` value
5. `SetLightingModeRequest.targets` — New field on the Rust request struct in `lighting_mode.rs`; gates USB serial checks

**Key data flow boundaries (must not be crossed):**
- Room map positions are frontend state; Hue channel xy coordinates are bridge-authoritative (fetched, never persisted locally as a cache)
- Zone derivation output (`LedCalibrationConfig`) is NEVER auto-applied — always presented as `initialConfig` to `CalibrationPage` for user confirmation
- `hueChannelRegionOverrides` (existing in `ShellState`) is independent of channel positions on the bridge

### Critical Pitfalls

1. **Hue channel position write-back ignored during active stream (P9)** — The Hue bridge silently ignores or rejects PUT to `entertainment_configuration` while a DTLS stream is active. Prevention: check stream status before write; offer stop-write-restart flow; validate success with a GET after PUT. Applies to Phase 3 (Hue Channel Position Editor).

2. **Canvas-to-Hue y-axis flip missing (P10)** — Hue y-axis is +1 at ceiling (up = positive), canvas y-axis is 0 at top (down = positive). Without a centralized `canvasToHue()` / `hueToCanvas()` utility with unit tests, dragged positions are written inverted. The existing `posToPercent()` in `HueChannelMapPanel.tsx` already handles this correctly for read-only display — the write path must use the same conversion. Applies to Phases 3 and 4.

3. **USB guard locks blocking Hue standalone mode (P12)** — `CalibrationRequiredBanner.tsx` and `ModeSelectorRow.tsx` check USB calibration state unconditionally. When `lastOutputTargets = ["hue"]`, all USB guards must be bypassed. Prevention: `isUsbTargetActive()` helper as single gate point; never inline `ledCalibration` checks without target context. Applies to Phase 5 (Standalone Mode).

4. **Dual-consumer data model confusion (P14)** — Room map state feeds two downstream consumers: Hue channel positions (bridge write) and LED zone hints (calibration derivation). Coupling them causes unintended side-effects when one consumer is updated. Prevention: treat `HueChannelPositions` and `LedZoneHints` as separate derived outputs; `ledCalibration` in `ShellState` must never be auto-overwritten by room map changes. Applies to Phase 1 (contract design).

5. **WebView2 GPU blocklist degrades canvas performance (P13)** — On Windows, WebView2 may disable GPU hardware acceleration for canvas, causing CPU spikes and jank when dragging even 10-20 nodes. Known workaround (Tauri Issue #4891, COMPLETED): `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--ignore-gpu-blocklist` in `main.rs`. Must be applied before canvas drag work begins. Applies to Phase 4 infra setup.

---

## Implications for Roadmap

Based on combined research, the architecture file provides a direct 7-step build order that maps cleanly to roadmap phases. This order is driven by hard dependency chains, not preference.

### Phase 1: Contract Foundation
**Rationale:** Every cross-boundary type must exist before implementation to prevent serialization mismatches that only surface at runtime. `yarn verify:shell-contracts` enforces alignment. This phase blocks all subsequent phases.
**Delivers:** New `roomMap.ts` contract file; `ShellState` extensions (`roomMap?`, `roomMapVersion?`, `ROOM_MAP` section ID); `hue.ts` extensions (`UPDATE_CHANNEL_POSITIONS` command, `CHANNEL_POSITIONS_UPDATED/FAILED` status codes); `RoomMapConfig`, `LightSourcePlacement`, `RoomDimensions` types.
**Addresses:** All features — no implementation can start without these.
**Avoids:** P14 (dual-consumer confusion — the separation between Hue position state and LED calibration state is enforced at contract level before any code is written).

### Phase 2: Fault Recovery and Diagnostics (HUE-08, HDR-01, HDR-02)
**Rationale:** Carried-over v1.1 debt. Standalone mode (Phase 5) inherits the Hue DTLS runtime — if fault recovery is unstable, standalone Hue users immediately encounter the worst-case experience. Must clear this debt before new surfaces depend on it. All required status codes (`TRANSIENT_RETRY_SCHEDULED`, `TRANSIENT_RETRY_EXHAUSTED`) already exist in contracts — this is additive implementation only.
**Delivers:** HUE-08 Rust reconnect retry loop with exponential backoff; HDR-01 Hue error code to user message + action hint mapping; HDR-02 Hue stream health fields in telemetry panel.
**Addresses:** HUE-08, HDR-01, HDR-02 from FEATURES.md MVP list.
**Avoids:** Shipping standalone mode on an unstable DTLS runtime.

### Phase 3: Hue Channel Position Editor
**Rationale:** Independent of the room map. Can be built against existing `HueChannelMapPanel.tsx` which already renders xy dots. The read path (`get_hue_area_channels`) already exists. Only the write command and drag interaction are new. Establishing the centralized coordinate conversion utility here prevents the y-flip bug from propagating into Phase 4 canvas work.
**Delivers:** `update_hue_channel_positions` Rust command in `hue_onboarding.rs`; `hueOnboardingApi.ts` write function; `HueChannelMapPanel.tsx` drag-to-reposition + "Save to Bridge" button; stream-active guard before write; GET validation after write; `canvasToHue()` / `hueToCanvas()` centralized utility with unit tests.
**Addresses:** Hue channel position read/write from FEATURES.md.
**Avoids:** P9 (write during active stream), P10 (y-flip — centralized utility established here, reused in Phase 4).

### Phase 4: Room Map UI
**Rationale:** Depends on Phase 1 contracts (`RoomMapConfig`, `roomMap.ts`). Does not require Rust changes. Canvas infrastructure (`--ignore-gpu-blocklist` flag) must be established at the start of this phase before any drag code is written.
**Delivers:** `RoomMapEditor.tsx` + `LightSourceDot.tsx` canvas; `roomMapStore.ts` with plugin-store persistence; `ROOM_MAP` settings sidebar section; TV + LED strip + Hue channel visual placement on shared canvas.
**Uses:** react-konva + konva (2D canvas, two-layer strategy: static background / interactive nodes), zustand (in-memory editing state), existing shellStore facade (persistence).
**Avoids:** P13 (WebView2 GPU — `--ignore-gpu-blocklist` applied before drag code is written), P15 (3D scope creep — 2D-first decision recorded as explicit constraint before implementation starts).

### Phase 5: Hue Standalone Mode
**Rationale:** Depends on Phase 2 (stable fault recovery). Widest blast radius of any v1.2 feature: touches `modeGuard.ts`, `OutputTargetsPanel.tsx`, `App.tsx` routing, and `lighting_mode.rs` Rust struct. Must be isolated to its own phase to avoid contaminating other work in progress.
**Delivers:** `canEnableHueStandaloneMode()` guard; `isLastSelected` guard relaxed in `OutputTargetsPanel.tsx`; `SetLightingModeRequest.targets: Vec<String>` in Rust; USB-free startup flow; Hue-only path visible in settings; `isUsbTargetActive()` helper replacing all inline `ledCalibration` checks.
**Addresses:** Hue Standalone Mode (Feature Group 4), HUX-02 target switching from FEATURES.md.
**Avoids:** P12 (USB guard locks — `isUsbTargetActive()` is the single gate point for all USB-gated UI elements).

### Phase 6: LED Zone Auto-Derivation
**Rationale:** Depends on Phase 4 (RoomMapConfig with `ledStripPlacement` must exist and be stable). The derivation function is pure TypeScript with no Tauri calls — can be unit-tested in full isolation before integration. Integration point is the existing `CalibrationPage` `initialConfig` prop, which requires no interface change.
**Delivers:** `zoneDerivation.ts` pure function (`RoomMapConfig -> LedCalibrationConfig`); "Auto-derive zones" action in RoomMapEditor that opens CalibrationPage with suggested config; user confirms via existing Save button.
**Addresses:** LED Zone Auto-Derivation (Feature Group 3) — P2 priority (post-core v1.2.x).
**Avoids:** P11 (LED zone coordinate mismatch — derivation is "suggestion only", auto-apply is architecturally blocked), P14 (dual-consumer — `ledCalibration` in ShellState is never touched by room map changes without explicit user confirmation).

### Phase 7: Device UX Polish (HUX-01, HUX-02 completion)
**Rationale:** Final integration polish. Depends on Phases 2 and 5 being stable (fault recovery and standalone mode). Additive changes only to existing surfaces — lower risk, focused on UX coherence before release gate.
**Delivers:** `DeviceSection.tsx` Hue stream health row; `hueRuntimeStatusCard.ts` extended signals; output target switching flow verified to preserve lighting mode state across target changes; release candidate readiness.
**Addresses:** HUX-01, HUX-02 from FEATURES.md MVP list.

### Phase Ordering Rationale

- Contracts before everything: Without types in `shared/contracts/`, Rust and TypeScript implementations diverge silently. `yarn verify:shell-contracts` catches mismatches only if the contracts exist first.
- Fault recovery before standalone: Standalone Hue users have no USB fallback. An unstable DTLS runtime in this context produces an unrecoverable state for a first-time setup. Phase 2 before Phase 5 is non-negotiable.
- Channel editor before room map: The `canvasToHue()` / `hueToCanvas()` coordinate utility must be established in Phase 3 before room map drag code is written in Phase 4. Establishing it here prevents the y-flip pitfall (P10) from being baked into Phase 4.
- Room map before zone derivation: `zoneDerivation.ts` consumes `RoomMapConfig.ledStripPlacement`. The derivation cannot be written correctly until the data model is stable and persisting correctly.
- Standalone before UX polish: HUX-01/02 surface refinements assume standalone mode is functional. Testing the full device section without standalone mode leads to rework.

### Research Flags

Phases needing deeper research during planning:
- **Phase 3 (Hue Channel Position Editor):** The PUT body schema for `entertainment_configuration` channel positions is inferred from aiohue model and HyperHDR discussions (MEDIUM confidence). The official Hue developer portal PUT schema is behind registration. Before writing the Rust handler, validate the exact `channels[].position.{x,y,z}` body format against a real bridge or the openhue-api OpenAPI YAML. The stream-lock behavior (bridge ignoring PUT during active stream) should also be verified experimentally before the guard implementation is finalized.
- **Phase 5 (Hue Standalone Mode):** The `lighting_mode.rs` Rust struct change (`targets: Vec<String>`) touches the most existing code. Review all callers of `set_lighting_mode` to identify any that construct `LightingModeRequest` without a targets field — decide whether `targets` should be optional with a backward-compatible default of `["usb"]` or required.

Phases with standard patterns (skip research-phase):
- **Phase 1 (Contracts):** Established contract-first pattern. Existing `shell.ts` and `hue.ts` are the direct templates. No new research needed.
- **Phase 2 (Fault Recovery):** All status codes already exist in `hue.ts`. The Rust retry loop pattern is established in `hue_stream_lifecycle.rs`. Additive changes to a known state machine.
- **Phase 4 (Room Map UI):** react-konva documentation is comprehensive. Konva two-layer strategy (static background + interactive layer) is the documented performance pattern. Zustand store shape is straightforward given the flat `RoomMapConfig` model.
- **Phase 6 (LED Zone Derivation):** Pure TypeScript bounding-box math. No external API, no new Rust, no new contracts. Unit-test first, then integrate.
- **Phase 7 (UX Polish):** Additive changes to known surfaces. No new architecture.

---

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | MEDIUM-HIGH | react-konva and zustand versions verified via npm and official repos. Hue CLIP v2 PUT body schema is MEDIUM — inferred from aiohue model, not verified against official gated portal. No new Rust crates removes a significant risk surface. |
| Features | MEDIUM | Feature priorities and MVP scope grounded in competitor analysis (Hyperion, Hue Sync Desktop, Govee DreamView) and community sources. Hue CLIP v2 coordinate ranges (-1 to +1) have multiple corroborating sources but official docs are behind registration. |
| Architecture | HIGH | Derived from direct codebase analysis of the existing LumaSync source (shell.ts, hue.ts, hue_stream_lifecycle.rs, modeGuard.ts, OutputTargetsPanel.tsx, HueChannelMapPanel.tsx). Integration points and blast radius for each feature are based on actual file contents, not inference. |
| Pitfalls | MEDIUM-HIGH | v1.0/v1.1 pitfalls are validated by prior milestone work. v1.2 pitfalls are grounded in code-level risk analysis (coordinate flip location, USB guard locations, stream lock behavior) plus documented Tauri and Hue API issues (WebView2 GPU blocklist: Issue #4891, COMPLETED). |

**Overall confidence:** MEDIUM-HIGH

### Gaps to Address

- **Hue CLIP v2 PUT body schema (exact format):** The `channels[].position.{x,y,z}` structure is inferred from aiohue and HyperHDR. During Phase 3 implementation, verify against a physical bridge before writing the Rust PUT handler. The openhue/openhue-api OpenAPI YAML contains the authoritative schema — extract it before writing `update_hue_channel_positions`.

- **Stream-lock behavior verification:** The claim that PUT to `entertainment_configuration` is silently ignored or rejected during active DTLS streaming is documented in community sources but not in official Hue API docs. Test this experimentally in early Phase 3 so the guard implementation matches actual bridge behavior.

- **`SetLightingModeRequest` backward compatibility:** Adding `targets: Vec<String>` to the Rust request struct will break any existing frontend callers that omit the field. Either make `targets` optional with a default of `["usb"]` for backward compatibility, or audit all `invoke("set_lighting_mode", ...)` call sites before Phase 5 begins.

- **Konva + Tauri macOS `macos-private-api`:** `macos-private-api: true` is already enabled for calibration overlays. Verify it has no interaction with Konva canvas hit detection on macOS before shipping the room map editor on that platform.

---

## Sources

### Primary (HIGH confidence)
- Direct codebase analysis: `src/shared/contracts/shell.ts`, `hue.ts`, `display.ts` — ShellState shape, HUE_COMMANDS, HUE_STATUS, HUE_RUNTIME_STATUS
- Direct codebase analysis: `src/features/calibration/model/contracts.ts` — LedCalibrationConfig shape and normalize functions
- Direct codebase analysis: `src/features/mode/state/modeGuard.ts`, `hueModeRuntimeFlow.ts` — guard logic, resolveHueRuntimePlan
- Direct codebase analysis: `src-tauri/src/commands/hue_stream_lifecycle.rs` — HueRuntimeStateStore, get_hue_area_channels (lines 1440-1490)
- Direct codebase analysis: `src/features/settings/sections/HueChannelMapPanel.tsx` — posToPercent y-flip implementation, existing xy rendering
- Direct codebase analysis: `src/features/settings/sections/control/OutputTargetsPanel.tsx` — isLastSelected guard (line 46)
- zustand GitHub (pmndrs/zustand) — version 5.0.12, React 19 compatibility confirmed
- React Konva performance tips — konvajs.org/docs/performance/All_Performance_Tips.html
- Tauri WebView2 GPU blocklist issue #4891 (COMPLETED) — `--ignore-gpu-blocklist` workaround confirmed

### Secondary (MEDIUM confidence)
- aiohue v2 entertainment_configuration model (home-assistant-libs/aiohue) — channel/position structure, xyz coordinate ranges
- Q42.HueApi EntertainmentApi.md (michielpost/Q42.HueApi) — GetLeft/GetRight spatial methods, xyz coordinate system
- HyperHDR Hue CLIP v2 discussion #512 (awawa-dev/HyperHDR) — channel xyz JSON examples: `{"x": -0.21547, "y": 1, "z": -1}`
- react-konva npm — version 19.2.3, peerDep react ^19.2.0 confirmed
- konva npm — version 10.2.3 current
- Samsung SmartThings Map View (CES 2024) — drag-drop 2D light positioning precedent
- Govee DreamView desktop user guide — zone division and screen region mapping

### Tertiary (LOW-MEDIUM confidence)
- openhue/openhue-api OpenAPI spec — comprehensive CLIP v2 spec exists; PUT body schema for channel positions not fully extracted (requires YAML inspection of entertainment_configuration resource)
- Hue Entertainment area 3D isometric setup (hueblog.com 2021) — corroborated by HyperHDR discussion
- CEPRO floor plan UI user fatigue analysis — supports 2D-first design decision

---
*Research completed: 2026-03-30*
*Ready for roadmap: yes*
