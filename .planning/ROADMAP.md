# Roadmap: LumaSync

## Milestone

**v1.1: Hue Entertainment Integration**

Derived only from v1.1 requirements in `.planning/REQUIREMENTS.md`.

## Phases

- [x] **Phase 9: Hue Bridge Onboarding** - User can discover, pair, select area, and confirm stream readiness.
- [x] **Phase 10: Hue Stream Lifecycle** - User can start, maintain, and stop Hue streaming from mode controls. (completed 2026-03-21)
- [ ] **Phase 11: Device Surface Integration** - User can manage Hue and switch output targets in existing device settings UX.
- [ ] **Phase 12: Diagnostics and Recovery** - User can recover from transient faults and troubleshoot stream health in-app.

## Phase Details

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
**Requirements**: HUX-01, HUX-02
**Success Criteria** (what must be TRUE):
  1. User can manage Hue connection, selected area, and live stream status from existing Device settings surfaces.
  2. User can switch output target between USB and Hue without losing saved calibration or active mode configuration.
  3. User can return to previously used output target and continue with expected configuration intact.
**Plans**: TBD

### Phase 12: Diagnostics and Recovery
**Goal**: Users can understand Hue failures and recover sessions without restarting the app.
**Depends on**: Phase 10, Phase 11
**Requirements**: HUE-08, HDR-01, HDR-02
**Success Criteria** (what must be TRUE):
  1. User can continue or resume a Hue session after transient stream faults without app restart.
  2. User can see coded Hue error states with actionable recovery guidance in the UI.
  3. User can inspect basic stream health signals during runtime to diagnose instability.
**Plans**: TBD

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 9. Hue Bridge Onboarding | 2/2 | Complete | 2026-03-21 |
| 10. Hue Stream Lifecycle | 5/5 | Complete    | 2026-03-21 |
| 11. Device Surface Integration | 0/TBD | Not started | - |
| 12. Diagnostics and Recovery | 0/TBD | Not started | - |
