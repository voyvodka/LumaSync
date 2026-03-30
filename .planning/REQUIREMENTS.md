# Requirements: LumaSync

**Defined:** 2026-03-30
**Core Value:** Users can get smooth, stable, low-overhead Ambilight behavior on a USB-connected WS2812B setup with minimal setup friction.

## v1.1 Requirements (Archived — carried incomplete items to v1.2)

All v1.1 requirements: see `.planning/milestones/` for archive.

Complete: HUE-01, HUE-02, HUE-03, HUE-04, HUE-05, HUE-06, HUE-07
Carried to v1.2: HUE-08, HUX-01, HUX-02, HDR-01, HDR-02

---

## v1.2 Requirements

Requirements for this milestone. Each maps to roadmap phases.

### Oda Haritası (ROOM)

- [ ] **ROOM-01**: User can create a 2D top-down room map with configurable room dimensions (width × depth in meters)
- [ ] **ROOM-02**: User can add furniture items (desk, sofa, TV stand, shelf, etc.) to the room as named reference objects with adjustable size and position
- [ ] **ROOM-03**: User can define named zones within the room (e.g. "TV Area", "Desk Zone") and assign lights to them
- [ ] **ROOM-04**: User can add Hue light sources to the map with representative shape and size (bulb, lightbar, gradient strip)
- [ ] **ROOM-05**: User can add a USB LED strip to the map with configurable length and wall placement
- [ ] **ROOM-06**: User can designate the TV/monitor as the center reference anchor of the room map
- [ ] **ROOM-07**: User can save and reload the room map (persisted via plugin-store)
- [ ] **ROOM-08**: User can upload a custom background image for the room map (floor plan photo or illustration)

### Hue Kanal Pozisyon Editörü (CHAN)

- [ ] **CHAN-01**: User can see all Hue Entertainment Area channels overlaid on the room map at their current x/y positions
- [ ] **CHAN-02**: User can drag individual Hue channels on the room map to update their x/y position
- [ ] **CHAN-03**: User can set the height (z-axis) for each Hue channel via a per-channel slider
- [ ] **CHAN-04**: User can select multiple channels and move them together as a group
- [ ] **CHAN-05** *(optional — experimental)*: User can write edited channel positions back to the Hue bridge (requires stream to be stopped; API behavior unconfirmed — validation phase required)

### LED Zone Otomatik Türetme (ZONE)

- [ ] **ZONE-01**: User can auto-derive Ambilight screen-edge zone assignments from the room map positions of lights relative to the TV anchor
- [ ] **ZONE-02**: User can review and confirm the derived zone assignments in a preview step before applying
- [ ] **ZONE-03**: User can apply confirmed zone assignments to the active LED calibration configuration

### Hue Standalone Modu (STND)

- [ ] **STND-01**: User can start Hue Entertainment streaming without a USB LED strip connected
- [ ] **STND-02**: App bypasses USB-dependent setup steps automatically when running in Hue-only mode
- [ ] **STND-03**: User can switch active output target between USB and Hue automatically based on connected hardware

### v1.1 Carry-overs

- [ ] **HUE-08**: User can continue a Hue session after transient stream faults without restarting the app
- [ ] **HUX-01**: User can manage Hue connection, area selection, and stream status from existing Device settings surfaces
- [ ] **HUX-02**: User can switch output target (USB vs Hue) without losing saved calibration or active mode configuration
- [ ] **HDR-01**: User can see coded Hue-related error states with actionable recovery hints in the UI
- [ ] **HDR-02**: User can inspect basic Hue stream health signals for troubleshooting during runtime

---

## Future Requirements

Deferred to future milestones.

### Profiles & Presets

- **PROF-01**: User can save and load named profiles for layout and mode settings.
- **MODE-03**: User can use basic preset effects beyond solid color.

### Expansion

- **MMON-01**: User can configure multi-monitor and multi-controller orchestration.
- **AUTO-01**: User can automate mode/profile switching via local API hooks.
- **MOB-01**: User can control the system from a mobile companion app.
- **ROOM-EXT-01**: User can manage multiple rooms with separate light source sets.

---

## Out of Scope

Explicitly excluded for v1.2.

| Feature | Reason |
|---------|--------|
| Isometric / 3D room renderer | 2–3× dev cost, WebGL WebView2 risks, 2D top-down is sufficient for zone derivation |
| Automatic furniture recognition (photo/AI) | Out of scope for lighting utility |
| Scale-based physics simulation | Not needed for light positioning |
| Hue write-back to bridge (CHAN-05) if API unconfirmed | Moved to experimental/optional — skip if PUT schema blocked |
| Multi-room support | Defer until single-room path is proven |
| Home Assistant bridge emulation | Advanced compatibility; defer |
| Multi-bridge synchronized streaming | Adds orchestration complexity; defer |
| Cloud sync for room map / credentials | Local-first design |

---

## Traceability

Which requirements map to which phases. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| HUE-08 | Phase 15 | Pending |
| HUX-01 | Phase 20 | Pending |
| HUX-02 | Phase 20 | Pending |
| HDR-01 | Phase 15 | Pending |
| HDR-02 | Phase 15 | Pending |
| ROOM-01 | Phase 17 | Pending |
| ROOM-02 | Phase 17 | Pending |
| ROOM-03 | Phase 17 | Pending |
| ROOM-04 | Phase 17 | Pending |
| ROOM-05 | Phase 17 | Pending |
| ROOM-06 | Phase 17 | Pending |
| ROOM-07 | Phase 17 | Pending |
| ROOM-08 | Phase 17 | Pending |
| CHAN-01 | Phase 16 | Pending |
| CHAN-02 | Phase 16 | Pending |
| CHAN-03 | Phase 16 | Pending |
| CHAN-04 | Phase 16 | Pending |
| CHAN-05 | Phase 20 | Pending (optional — experimental) |
| ZONE-01 | Phase 19 | Pending |
| ZONE-02 | Phase 19 | Pending |
| ZONE-03 | Phase 19 | Pending |
| STND-01 | Phase 18 | Pending |
| STND-02 | Phase 18 | Pending |
| STND-03 | Phase 18 | Pending |

**Coverage:**
- v1.2 requirements: 24 total (23 mandatory + 1 optional)
- Mapped to phases: 24/24 ✓
- Unmapped: 0

**Phase coverage summary:**
- Phase 14 (Contract Foundation): All types — scaffolds Phases 15-20
- Phase 15 (Fault Recovery + Diagnostics): HUE-08, HDR-01, HDR-02
- Phase 16 (Hue Channel Position Editor): CHAN-01, CHAN-02, CHAN-03, CHAN-04
- Phase 17 (Room Map UI): ROOM-01, ROOM-02, ROOM-03, ROOM-04, ROOM-05, ROOM-06, ROOM-07, ROOM-08
- Phase 18 (Hue Standalone Mode): STND-01, STND-02, STND-03
- Phase 19 (LED Zone Auto-Derivation): ZONE-01, ZONE-02, ZONE-03
- Phase 20 (Device UX Polish + Channel Write-back): HUX-01, HUX-02, CHAN-05

---
*Requirements defined: 2026-03-30*
*Last updated: 2026-03-30 after v1.2 roadmap creation — all 24 requirements mapped*
