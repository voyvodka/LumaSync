# Roadmap: LumaSync

## Milestones

- ✅ **v1.0 MVP** - Phases 1-8 (shipped 2026-03-21)
- ✅ **v1.1 Hue Entertainment Integration** - Phases 9-13 (shipped 2026-03-29)
- 🚧 **v1.2 Oda Gorselleştirme ve Evrensel Isik Yonetimi** - Phases 14-20 (in progress)

## Phases

<details>
<summary>✅ v1.0 MVP (Phases 1-8) — SHIPPED 2026-03-21</summary>

Phase 1-8 tamamlandı. Detaylar: `.planning/milestones/v1.0-ROADMAP.md`

</details>

<details>
<summary>✅ v1.1 Hue Entertainment Integration (Phases 9-13) — SHIPPED 2026-03-29</summary>

### Phase 9: Hue Bridge Onboarding
**Goal**: Users can connect LumaSync to a Hue bridge and prepare a valid entertainment area before streaming.
**Depends on**: Phase 8
**Requirements**: HUE-01, HUE-02, HUE-03, HUE-04
**Success Criteria** (what must be TRUE):
  1. User can find a bridge via auto-discovery and still connect with manual IP when discovery fails.
  2. User can complete pairing and later reopen the app without repeating pairing for the same bridge.
  3. User can view available entertainment areas and select one for output.
  4. User can clearly see whether the selected bridge/area is stream-ready before pressing start.
**Plans**: 2 plans

Plans:
- [x] 09-01-PLAN.md - Build Hue onboarding backend contracts, command surface, and persistence model.
- [x] 09-02-PLAN.md - Implement Device-surface Hue onboarding step flow, area readiness UX, and i18n parity.

### Phase 10: Hue Stream Lifecycle
**Goal**: Users can run Hue entertainment output as a stable runtime mode from the app controls.
**Depends on**: Phase 9
**Requirements**: HUE-05, HUE-06, HUE-07
**Success Criteria** (what must be TRUE):
  1. User can start Hue Entertainment streaming for the selected area directly from mode controls.
  2. User can keep Hue streaming active during runtime without visible dropouts under normal conditions.
  3. User can stop Hue streaming and see bridge/device state return to expected non-stream state.
**Plans**: 3 plans

Plans:
- [x] 10-01-PLAN.md - Build backend Hue runtime owner/state machine, strict start gate, bounded reconnect, and deterministic stop commands.
- [x] 10-02-PLAN.md - Move Hue start authority to mode controls with dual-target arbitration and persisted target set.
- [x] 10-03-PLAN.md - Add Device-surface runtime observability, shared stop pipeline UX, and EN/TR lifecycle copy parity.

### Phase 11: Device Surface Integration
**Goal**: Users can control Hue and USB output paths through one consistent Device settings experience.
**Depends on**: Phase 10
**Requirements**: HUX-01, HUX-02 (carried to v1.2)
**Success Criteria** (what must be TRUE):
  1. User can manage Hue connection, selected area, and live stream status from existing Device settings surfaces.
  2. User can switch output target between USB and Hue without losing saved calibration or active mode configuration.
**Plans**: Deferred to v1.2

### Phase 12: Diagnostics and Recovery
**Goal**: Users can understand Hue failures and recover sessions without restarting the app.
**Depends on**: Phase 10, Phase 11
**Requirements**: HUE-08, HDR-01, HDR-02 (carried to v1.2)
**Success Criteria** (what must be TRUE):
  1. User can continue or resume a Hue session after transient stream faults without app restart.
  2. User can see coded Hue error states with actionable recovery guidance in the UI.
  3. User can inspect basic stream health signals during runtime to diagnose instability.
**Plans**: Deferred to v1.2

### Phase 13: Structured Logging
**Goal**: tauri-plugin-log entegrasyonu ile Hue lifecycle event'lerinin yapilandirilmis log ciktisina baglanmasi.
**Depends on**: Phase 12
**Plans**: 1 plan

Plans:
- [x] 13-01-PLAN.md - tauri-plugin-log kurulumu, plugin kaydi ve Hue lifecycle log migration.

</details>

---

### 🚧 v1.2 Oda Gorselleştirme ve Evrensel Isik Yonetimi (In Progress)

**Milestone Goal:** Kullanicinin odadaki tum isik kaynaklarini tek bir oda haritasinda konumlandirabildigi, Ambilight bolgelerinin bu haritadan otomatik turetildigi ve Hue'nun USB seritten bagimsiz da calisabildigi evrensel bir isik yonetim sistemi.

- [ ] **Phase 14: Contract Foundation** - All v1.2 cross-boundary types defined before implementation begins.
- [ ] **Phase 15: Fault Recovery and Diagnostics** - Hue session auto-recovers from transient faults; error states shown with actionable hints.
- [ ] **Phase 16: Hue Channel Position Editor** - User can view and drag Hue channel positions on the map and optionally save to bridge.
- [ ] **Phase 17: Room Map UI** - User can build a 2D room map with lights, furniture, TV anchor, and background image.
- [ ] **Phase 18: Hue Standalone Mode** - App runs Hue streaming without a USB LED strip.
- [ ] **Phase 19: LED Zone Auto-Derivation** - Ambilight screen-edge zones auto-derived from room map positions.
- [ ] **Phase 20: Device UX Polish and Channel Write-back** - Device surface Hue controls polished; CHAN-05 experimental write-back added if API confirmed.

## Phase Details

### Phase 14: Contract Foundation
**Goal**: All v1.2 cross-boundary types are defined and enforced before any implementation starts, preventing serialization mismatches between Rust and TypeScript.
**Depends on**: Phase 13
**Requirements**: ROOM-01, ROOM-02, ROOM-03, ROOM-04, ROOM-05, ROOM-06, ROOM-07, ROOM-08, CHAN-01, CHAN-02, CHAN-03, CHAN-04, CHAN-05, ZONE-01, ZONE-02, ZONE-03, STND-01, STND-02, STND-03
**Success Criteria** (what must be TRUE):
  1. `yarn verify:shell-contracts` passes with all new room map section IDs and command codes present.
  2. `RoomMapConfig`, `LightSourcePlacement`, and `RoomDimensions` types exist in `src/shared/contracts/roomMap.ts` and compile without errors.
  3. `ShellState` is extended with `roomMap?` and `roomMapVersion?` keys that round-trip through plugin-store without data loss.
  4. `hue.ts` contains `UPDATE_CHANNEL_POSITIONS` command and `CHANNEL_POSITIONS_UPDATED`/`CHANNEL_POSITIONS_FAILED` status codes.
**Plans**: 3 plans

Plans:
- [ ] 14-01-PLAN.md — TypeScript contract definitions (roomMap.ts, shell.ts extension, hue.ts extension)
- [ ] 14-02-PLAN.md — Rust mirror structs and Tauri command stubs (models/room_map.rs, commands/room_map.rs, lib.rs)
- [ ] 14-03-PLAN.md — Repair and extend verify:shell-contracts script for full validation

### Phase 15: Fault Recovery and Diagnostics
**Goal**: Users can recover from Hue stream faults automatically and see clear, actionable error messages when problems occur.
**Depends on**: Phase 14
**Requirements**: HUE-08, HDR-01, HDR-02
**Success Criteria** (what must be TRUE):
  1. User can experience a simulated DTLS connection drop and see the stream automatically reconnect within seconds without touching the app.
  2. User can see a specific error code with a plain-language explanation and a suggested action (e.g. "Bridge unreachable — check network connection") when a Hue fault occurs.
  3. User can open the telemetry panel during an active Hue stream and see stream health signals (packet rate, last error, retry count).
  4. User can observe that after maximum retries are exhausted, the app enters a stopped state with a recoverable error message rather than crashing.
**Plans**: TBD

### Phase 16: Hue Channel Position Editor
**Goal**: Users can see their Hue Entertainment Area channels positioned on the map, drag them to update positions, and inspect height per channel.
**Depends on**: Phase 14
**Requirements**: CHAN-01, CHAN-02, CHAN-03, CHAN-04
**Success Criteria** (what must be TRUE):
  1. User can open the channel position editor and see all channels from the selected Entertainment Area rendered at their current x/y coordinates.
  2. User can drag a single channel dot on the editor and see its position update live with correct spatial orientation (bridge y-axis and canvas y-axis properly aligned).
  3. User can adjust the height (z-axis) for any channel using a per-channel slider and see the value reflected immediately.
  4. User can select multiple channel dots together and move them as a group without affecting unselected channels.
**Plans**: TBD
**UI hint**: yes

### Phase 17: Room Map UI
**Goal**: Users can build and save a persistent 2D top-down room map that places their TV, USB LED strip, Hue channels, and furniture as positioned objects.
**Depends on**: Phase 14, Phase 16
**Requirements**: ROOM-01, ROOM-02, ROOM-03, ROOM-04, ROOM-05, ROOM-06, ROOM-07, ROOM-08
**Success Criteria** (what must be TRUE):
  1. User can set room dimensions (width x depth in meters) and see the canvas scale accordingly.
  2. User can drag a TV/monitor marker onto the map and designate it as the center anchor; the anchor persists across sessions.
  3. User can add Hue channel dots and a USB LED strip to the room map and reposition them by dragging.
  4. User can add furniture items (desk, sofa, shelf) as labeled reference objects and resize them.
  5. User can upload a floor plan image as the map background and save the complete room map; on app restart the map loads intact.
**Plans**: TBD
**UI hint**: yes

### Phase 18: Hue Standalone Mode
**Goal**: Users can start and sustain Hue Entertainment streaming without a USB LED strip connected, and the app does not show USB error states in this mode.
**Depends on**: Phase 15
**Requirements**: STND-01, STND-02, STND-03
**Success Criteria** (what must be TRUE):
  1. User can launch the app with no USB serial device connected, navigate to mode controls, and start Hue streaming without seeing USB error banners or blocked controls.
  2. User can operate in Hue-only mode through a full session (stream start, maintain, stop) and the app never prompts for USB calibration.
  3. User can plug in a USB LED strip while in Hue-only mode and have the app detect it and offer USB as an additional output target without interrupting the Hue stream.
**Plans**: TBD

### Phase 19: LED Zone Auto-Derivation
**Goal**: Users can derive Ambilight screen-edge zone assignments automatically from the room map and apply them to calibration with explicit confirmation.
**Depends on**: Phase 17
**Requirements**: ZONE-01, ZONE-02, ZONE-03
**Success Criteria** (what must be TRUE):
  1. User can press "Auto-derive zones" from the room map editor and see screen-edge assignments (top/bottom/left/right) suggested based on the relative positions of the LED strip and TV anchor.
  2. User can review the derived zone assignments in a preview step showing a visual layout before any calibration data is changed.
  3. User can confirm the derived assignments and have them applied as the initial calibration configuration; the existing saved calibration is not overwritten until the user saves explicitly in CalibrationPage.
**Plans**: TBD
**UI hint**: yes

### Phase 20: Device UX Polish and Channel Write-back
**Goal**: Device settings surfaces show complete Hue control with live stream health; CHAN-05 channel write-back is added if the Hue CLIP v2 PUT schema is confirmed against a real bridge.
**Depends on**: Phase 15, Phase 18
**Requirements**: HUX-01, HUX-02, CHAN-05
**Success Criteria** (what must be TRUE):
  1. User can see Hue stream status (connected, streaming, error state) and the selected entertainment area name in the Device settings section without opening a separate panel.
  2. User can switch the active output target between USB and Hue in Device settings and have the active lighting mode continue without requiring re-configuration.
  3. *(CHAN-05 — conditional on API verification)* User can press "Save positions to bridge" in the channel editor after stopping the stream and have the edited x/y/z positions written to the bridge; a subsequent read confirms the positions match.
**Plans**: TBD
**UI hint**: yes

## Progress

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 9. Hue Bridge Onboarding | v1.1 | 2/2 | Complete | 2026-03-21 |
| 10. Hue Stream Lifecycle | v1.1 | 3/3 | Complete | 2026-03-21 |
| 11. Device Surface Integration | v1.1 | 0/0 | Deferred to v1.2 | - |
| 12. Diagnostics and Recovery | v1.1 | 0/0 | Deferred to v1.2 | - |
| 13. Structured Logging | v1.1 | 1/1 | Complete | 2026-03-29 |
| 14. Contract Foundation | v1.2 | 0/3 | Planned | - |
| 15. Fault Recovery and Diagnostics | v1.2 | 0/TBD | Not started | - |
| 16. Hue Channel Position Editor | v1.2 | 0/TBD | Not started | - |
| 17. Room Map UI | v1.2 | 0/TBD | Not started | - |
| 18. Hue Standalone Mode | v1.2 | 0/TBD | Not started | - |
| 19. LED Zone Auto-Derivation | v1.2 | 0/TBD | Not started | - |
| 20. Device UX Polish and Channel Write-back | v1.2 | 0/TBD | Not started | - |
