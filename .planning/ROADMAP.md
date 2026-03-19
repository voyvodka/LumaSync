# Roadmap: LumaSync

## Overview

Bu roadmap, USB-first Ambilight deneyimini kullanici acisindan calisir hale getirecek sekilde ilerler: once uygulama kabugu ve baglanti omurgasi, sonra kalibrasyon ve modlar, en sonda kalite/telemetri/stabilite ve tam dil kapsami. Her faz, tek basina dogrulanabilir bir kullanici kabiliyeti teslim eder.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

- [x] **Phase 1: App Shell and Baseline Defaults** - Tray tabanli uygulama acilir, ayarlar penceresi erisilebilir ve ilk acilis varsayimlari oturur. (completed 2026-03-19)
- [ ] **Phase 2: USB Connection Setup** - Cihaz auto-detect ve manuel port fallback ile baglanti kurulabilir.
- [ ] **Phase 3: Connection Resilience and Health** - Kopma-sonrasi toparlanma ve setup sirasinda saglik kontrolu guvenilir calisir.
- [ ] **Phase 4: Calibration Workflow** - Kullanici wizard ve ileri ayarlardan dogru LED haritalamasini tamamlar.
- [ ] **Phase 5: Core Lighting Modes** - Realtime Ambilight ve solid-color modlari kullanilabilir olur.
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
**Plans**: 5 plans
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
**Plans**: TBD

### Phase 3: Connection Resilience and Health
**Goal**: Baglanti kesintileri sonrasinda oturum kullaniciyi yarida birakmadan toparlanir ve baglanti durumu dogrulanabilir olur.
**Depends on**: Phase 2
**Requirements**: CONN-03, CONN-04
**Success Criteria** (what must be TRUE):
  1. User can unplug and replug the cable and the session recovers without app restart.
  2. User can run a setup health check and receive clear pass/fail status.
  3. User can understand current connection condition from in-app status feedback.
**Plans**: TBD

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
**Plans**: TBD

### Phase 5: Core Lighting Modes
**Goal**: Kullanici ana kullanim modlarini secip LED cikisini amacina gore degistirebilir.
**Depends on**: Phase 4
**Requirements**: MODE-01, MODE-02
**Success Criteria** (what must be TRUE):
  1. User can switch to real-time Ambilight screen mirroring mode.
  2. User can switch to a static solid-color mode.
  3. User can change modes without losing saved calibration setup.
**Plans**: TBD

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
| 2. USB Connection Setup | 0/TBD | Not started | - |
| 3. Connection Resilience and Health | 0/TBD | Not started | - |
| 4. Calibration Workflow | 0/TBD | Not started | - |
| 5. Core Lighting Modes | 0/TBD | Not started | - |
| 6. Runtime Quality Controls | 0/TBD | Not started | - |
| 7. Telemetry and Full Localization | 0/TBD | Not started | - |
| 8. Stability Gate | 0/TBD | Not started | - |
