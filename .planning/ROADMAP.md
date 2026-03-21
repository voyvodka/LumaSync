# Roadmap: LumaSync

## Overview

Bu roadmap, USB-first Ambilight deneyimini kullanici acisindan calisir hale getirecek sekilde ilerler: once uygulama kabugu ve baglanti omurgasi, sonra kalibrasyon ve modlar, en sonda kalite/telemetri/stabilite ve tam dil kapsami. Her faz, tek basina dogrulanabilir bir kullanici kabiliyeti teslim eder.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

- [x] **Phase 1: App Shell and Baseline Defaults** - Tray tabanli uygulama acilir, ayarlar penceresi erisilebilir ve ilk acilis varsayimlari oturur. (completed 2026-03-19)
- [x] **Phase 2: USB Connection Setup** - Cihaz auto-detect ve manuel port fallback ile baglanti kurulabilir. (completed 2026-03-19)
- [x] **Phase 3: Connection Resilience and Health** - Kopma-sonrasi toparlanma ve setup sirasinda saglik kontrolu guvenilir calisir. (completed 2026-03-19)
- [x] **Phase 4: Calibration Workflow** - Kullanici wizard ve ileri ayarlardan dogru LED haritalamasini tamamlar. (completed 2026-03-19)
- [x] **Phase 5: Core Lighting Modes** - Realtime Ambilight ve solid-color modlari kullanilabilir olur. (completed 2026-03-21)
- [ ] **Phase 6: Runtime Quality Controls** - Smoothing ve adaptif gonderim davranisi ile deneyim daha yumusak ve hafif olur.
- [ ] **Phase 7: Telemetry and Full Localization** - Temel telemetri gorunurlugu ve TR/EN dil destegi tamamlanir.
- [ ] **Phase 8: Stability Gate** - Sistem 60 dakikalik kesintisiz calismayi crash olmadan gecer.

## Phase Details

### Phase 1: App Shell and Baseline Defaults
**Goal**: Kullanici uygulamayi tray odakli sekilde calistirip ayarlar penceresine ulasabilir; ilk acilis varsayimi dogru sekilde uygulanir.
**Depends on**: Nothing (first phase)
**Requirements**: UX-01, I18N-02
**Success Criteria** (what must be TRUE):
  1. User can launch the app and see it running in the system tray.
  2. User can open the full settings window from the tray at any time.
  3. User sees English as the default language on first launch.
**Plans**: 6 plans
Plans:
- [ ] 01-01-PLAN.md - Build tray-first runtime lifecycle and shell contracts for UX-01
- [ ] 01-03-PLAN.md - Implement settings scaffold and shell persistence baseline for UX-01
- [ ] 01-02-PLAN.md - Implement first-launch English i18n baseline with explicit I18N-02 conflict alignment handling
- [ ] 01-04-PLAN.md - Close diagnosed UAT gaps for single tray icon, startup toggle sync, and macOS fullscreen close-to-tray reliability
- [ ] 01-05-PLAN.md - Close remaining fullscreen close runtime gap with staged macOS hide flow and add I18N-02 fallback regression guard

### Phase 2: USB Connection Setup
**Goal**: Kullanici desteklenen USB serial kontrolcuyu hizli sekilde bulup baglayabilir.
**Depends on**: Phase 1
**Requirements**: CONN-01, CONN-02
**Success Criteria** (what must be TRUE):
  1. User can see supported controllers detected automatically when connected.
  2. User can manually choose a COM/serial port when auto-detection misses.
  3. User can complete initial device connection without restarting the app.
**Plans**: 4 plans
Plans:
- [ ] 02-01-PLAN.md - Define device contracts and test-backed port classification/selection memory rules
- [ ] 02-02-PLAN.md - Implement Rust serial list/connect commands and register Tauri capability surface
- [ ] 02-03-PLAN.md - Deliver Device panel scan-select-connect UX with status card and EN/TR copy parity
- [ ] 02-04-PLAN.md - Close verification gaps for Refresh button contrast and refresh spam-control feedback

### Phase 3: Connection Resilience and Health
**Goal**: Baglanti kesintileri sonrasinda oturum kullaniciyi yarida birakmadan toparlanir ve baglanti durumu dogrulanabilir olur.
**Depends on**: Phase 2
**Requirements**: CONN-03, CONN-04
**Success Criteria** (what must be TRUE):
  1. User can unplug and replug the cable and the session recovers without app restart.
  2. User can run a setup health check and receive clear pass/fail status.
  3. User can understand current connection condition from in-app status feedback.
**Plans**: 3 plans
Plans:
- [ ] 03-01-PLAN.md - Implement test-backed recovery/health orchestration contracts and controller+backend behavior for CONN-03 and CONN-04
- [ ] 03-02-PLAN.md - Wire Device panel health-check/reconnecting status UX with deterministic mapping and EN/TR parity
- [ ] 03-03-PLAN.md - Close verification gap by rendering full health-check step outcomes in Device panel with deterministic status mapping

### Phase 4: Calibration Workflow
**Goal**: Kullanici ilk kurulumda wizard ile, sonrasinda ileri panel ile LED geometri ve yonlendirmeyi dogru kalibre edebilir.
**Depends on**: Phase 3
**Requirements**: CAL-01, CAL-02, CAL-03, CAL-04, UX-02
**Success Criteria** (what must be TRUE):
  1. User can complete first-time setup through a guided wizard flow.
  2. User can apply a predefined monitor template and then fine-tune start index and direction.
  3. User can configure edge LED counts and physical gap regions to match real hardware.
  4. User can validate LED mapping with live preview/test pattern before saving.
  5. User can revisit and adjust calibration later from an advanced settings panel.
**Plans**: 15 plans
Plans:
- [ ] 04-01-PLAN.md - Build test-backed calibration contracts, template catalog, and deterministic LED mapping engine
- [ ] 04-02-PLAN.md - Deliver shared wizard/advanced calibration overlay flow with explicit save and dirty-exit guard
- [ ] 04-03-PLAN.md - Add live test-pattern preview + hardware command bridge with disconnected-safe fallback
- [ ] 04-04-PLAN.md - [gap] Wire validation to save handler and add bottomGapPx editor input (CAL-03)
- [ ] 04-05-PLAN.md - [gap] Connect buildLedSequence to test pattern physical payload (CAL-04)
- [ ] 04-06-PLAN.md - [gap] Restore mapping-order parity across buildLedSequence, physical payload marker index, and overlay preview segment label (CAL-04)
- [ ] 04-07-PLAN.md - [gap] Add mapping-order parity regression hardening and physical parity re-verification gate (CAL-04)
- [ ] 04-08-PLAN.md - [gap] Close remaining CAL-04 parity gap by hardening model-flow-overlay mapping contract
- [ ] 04-09-PLAN.md - [gap] Add calibration-required LED mode guard and disabled-toggle CTA UX in General settings (UX-02)
- [ ] 04-10-PLAN.md - [gap] Add display-target lifecycle slice with single-active overlay switching and blocked-reason UX (CAL-04)
- [ ] 04-11-PLAN.md - [gap] Run final hardware UAT closure and update verification status for CAL/UX requirements
- [ ] 04-12-PLAN.md - Add first-connection auto-open guard plus Settings > Calibration summary/edit entry wiring (UX-02)
- [ ] 04-13-PLAN.md - [gap] Replace state-only display overlay command with real OS-level overlay lifecycle and blocked-reason runtime hardening (CAL-04, UX-02)
- [ ] 04-14-PLAN.md - [gap] Re-run diagnosed UAT tests (2/7/8/9), clarify dirty-exit test path, and sync verification closure (CAL-04, UX-02)
- [ ] 04-15-PLAN.md - [gap] Complete Settings > Calibration overview visual missing pieces with richer summary cards and empty-state guidance (UX-02, CAL-03)

### Phase 5: Core Lighting Modes
**Goal**: Kullanici ana kullanim modlarini secip LED cikisini amacina gore degistirebilir.
**Depends on**: Phase 4
**Requirements**: MODE-01, MODE-02
**Success Criteria** (what must be TRUE):
  1. User can switch to real-time Ambilight screen mirroring mode.
  2. User can switch to a static solid-color mode.
  3. User can change modes without losing saved calibration setup.
**Plans**: 5 plans
Plans:
- [ ] 05-01-PLAN.md - Define MODE-01/MODE-02 domain contracts, command bridge surface, and test-backed transition/persistence rules
- [ ] 05-02-PLAN.md - Implement Rust lighting-mode runtime owner with transactional set/stop lifecycle and Tauri command registration
- [ ] 05-03-PLAN.md - Wire General settings mode UI to runtime+persistence and close phase with physical hardware UAT checkpoint
- [ ] 05-04-PLAN.md - [gap] Replace no-op/stub lighting output paths with real device output bridge, rerun hardware UAT, and sync verification closure
- [ ] 05-05-PLAN.md - [gap] Replace synthetic ambilight frame generation with real capture->sample->send runtime pipeline and resync MODE-01 verification closure
- [ ] 05-06-PLAN.md - [gap] Replace static Ambilight frame source default with live monitor capture source and close remaining MODE-01 blocker

### Phase 6: Runtime Quality Controls
**Goal**: Realtime modda goruntu gecisleri yumusar ve runtime davranisi sistem yukunu dengeleyerek calisir.
**Depends on**: Phase 5
**Requirements**: QUAL-01, QUAL-02
**Success Criteria** (what must be TRUE):
  1. User experiences smooth color transitions without harsh flicker in normal use.
  2. User sees stable Ambilight behavior while system load is kept controlled by adaptive frame/send logic.
  3. User can keep Ambilight active during typical desktop use without noticeable stutter spikes.
**Plans**: TBD

### Phase 7: Telemetry and Full Localization
**Goal**: Kullanici kaliteyi gozlemleyebilir ve uygulamayi hem Turkce hem Ingilizce kullanabilir.
**Depends on**: Phase 6
**Requirements**: QUAL-03, I18N-01
**Success Criteria** (what must be TRUE):
  1. User can open a telemetry view showing capture FPS, send FPS, and queue health.
  2. User can switch app language between English and Turkish.
  3. User can continue setup and mode-management flows in either supported language.
**Plans**: TBD

### Phase 8: Stability Gate
**Goal**: v1 cikisi icin gerekli uzun sureli calisma guvenilirligi kullanici perspektifinden dogrulanir.
**Depends on**: Phase 7
**Requirements**: QUAL-04
**Success Criteria** (what must be TRUE):
  1. User can run the system continuously for 60 minutes without app crash.
  2. User can complete a long run without needing manual restart to restore normal operation.
**Plans**: TBD

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. App Shell and Baseline Defaults | 5/5 | Complete   | 2026-03-19 |
| 2. USB Connection Setup | 4/4 | Complete   | 2026-03-19 |
| 3. Connection Resilience and Health | 3/3 | Complete    | 2026-03-19 |
| 4. Calibration Workflow | 12/12 | Complete   | 2026-03-20 |
| 5. Core Lighting Modes | 4/4 | Complete | 2026-03-21 |
| 6. Runtime Quality Controls | 0/TBD | Not started | - |
| 7. Telemetry and Full Localization | 0/TBD | Not started | - |
| 8. Stability Gate | 0/TBD | Not started | - |
