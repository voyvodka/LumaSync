# Requirements: Ambilight Desktop

**Defined:** 2026-03-19
**Core Value:** Users can get smooth, stable, low-overhead Ambilight behavior on a USB-connected WS2812B setup with minimal setup friction.

## v1 Requirements

Requirements for initial release. Each maps to roadmap phases.

### Connection

- [ ] **CONN-01**: User can auto-detect supported USB serial LED controllers
- [ ] **CONN-02**: User can manually select a serial port when auto-detect fails
- [ ] **CONN-03**: User session auto-recovers after cable unplug/replug without app restart
- [ ] **CONN-04**: User can run a connection health check during setup and see pass/fail status

### Calibration

- [ ] **CAL-01**: User can complete setup using predefined monitor LED templates
- [ ] **CAL-02**: User can set LED start index and direction for correct strip orientation
- [ ] **CAL-03**: User can configure edge LED counts and gap areas (for example bottom center gap)
- [ ] **CAL-04**: User can validate mapping using live preview/test pattern before saving

### Lighting Modes

- [ ] **MODE-01**: User can enable real-time Ambilight screen mirroring mode
- [ ] **MODE-02**: User can enable a static solid-color mode

### Quality & Reliability

- [ ] **QUAL-01**: User gets soft color transitions (smoothing) that avoid harsh flicker
- [ ] **QUAL-02**: User gets adaptive frame/send behavior (FPS/coalescing) to reduce system load
- [ ] **QUAL-03**: User can view a basic telemetry panel (capture FPS, send FPS, queue health)
- [ ] **QUAL-04**: System passes a 60-minute continuous stability run without crash

### UX & App Behavior

- [ ] **UX-01**: User can run the app from system tray and open full settings window on demand
- [ ] **UX-02**: User can complete first-time setup via guided wizard and later use advanced settings panel

### Localization

- [ ] **I18N-01**: User can use the app in English and Turkish
- [ ] **I18N-02**: App defaults to English on first launch

## v2 Requirements

Deferred to future release. Tracked but not in current roadmap.

### Lighting & Profiles

- **MODE-03**: User can use basic preset effects beyond solid color
- **PROF-01**: User can save and load named profiles for layout and mode settings

### Connectivity & Extensibility

- **NET-01**: User can control compatible devices over network transport (WLED/UDP/MQTT)
- **AUTO-01**: User can automate mode/profile switching via local API hooks

### Product Expansion

- **MMON-01**: User can configure multi-monitor and multi-controller orchestration
- **MOB-01**: User can control the system from a mobile companion app

## Out of Scope

Explicitly excluded. Documented to prevent scope creep.

| Feature | Reason |
|---------|--------|
| Cloud account and sync | Adds auth/privacy complexity; not required for local-first v1 |
| Advanced effect editor (timeline/node based) | High engine + UX complexity; delays core reliability |
| Plugin marketplace | Requires governance/security model too early |
| Firmware flashing from app | v1 scope uses firmware code sharing/copy flow, not direct flashing |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| CONN-01 | Phase 2 | Pending |
| CONN-02 | Phase 2 | Pending |
| CONN-03 | Phase 3 | Pending |
| CONN-04 | Phase 3 | Pending |
| CAL-01 | Phase 4 | Pending |
| CAL-02 | Phase 4 | Pending |
| CAL-03 | Phase 4 | Pending |
| CAL-04 | Phase 4 | Pending |
| MODE-01 | Phase 5 | Pending |
| MODE-02 | Phase 5 | Pending |
| QUAL-01 | Phase 6 | Pending |
| QUAL-02 | Phase 6 | Pending |
| QUAL-03 | Phase 7 | Pending |
| QUAL-04 | Phase 8 | Pending |
| UX-01 | Phase 1 | Pending |
| UX-02 | Phase 4 | Pending |
| I18N-01 | Phase 7 | Pending |
| I18N-02 | Phase 1 | Pending |

**Coverage:**
- v1 requirements: 18 total
- Mapped to phases: 18
- Unmapped: 0 ✓

---
*Requirements defined: 2026-03-19*
*Last updated: 2026-03-19 after roadmap mapping*
