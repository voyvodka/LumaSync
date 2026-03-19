# Project Research Summary

**Project:** LumaSync
**Domain:** Windows-first desktop Ambilight app (USB serial WS2812B)
**Researched:** 2026-03-19
**Confidence:** MEDIUM

## Executive Summary

Bu proje, USB ile bagli WS2812B LED seridini monitor kenar renkleriyle gercek zamanli suren, tray-first calisan ve uzun sure stabil kalmasi gereken bir masaustu Ambilight urunudur. Arastirma ciktisi net: uzman ekipler bu tur urunleri "UI odakli" degil, "runtime motoru odakli" tasarlar. Kalip olarak capture -> color pipeline -> serial transport akisini tek bir orchestrator state machine ile yonetir, UI'yi sadece kontrol yuzeyi olarak tutar.

Onerilen uygulama yontemi Windows-first ve USB-first kalmaktir: Tauri v2 + Rust/Tokio runtime, Windows'a ozel capture backend, bounded serial write queue, profile/store tabanli local-first konfig. MVP'de odak, rekabetci genislik degil; dogru geometri kalibrasyonu, guvenilir reconnect, yumusak renk gecisleri, profil/tray akisi ve 60 dakika stabil calisma hedefidir. Multi-monitor, telemetri panelinin ileri seviyesi, auto black-bar heuristics ve network transport sonraki asamalara alinmalidir.

En buyuk riskler performans (CPU brute-force capture), renk dogrulugu (HDR/SDR farki), serial throughput doygunlugu ve recovery eksikligidir. Bunlar roadmap'te erken fazlarda teknik guardrail olarak ele alinirsa v1 riski ciddi azalir: frame budget + backpressure, HDR capability probe, serial bant-genisligi butcesi, explicit `recovering` state, soak/fault-injection release gate.

## Key Findings

### Recommended Stack

Stack arastirmasi Tauri v2 + Rust tabanli desktop shell/runtime ayrimini destekliyor. Bu secim, background utility senaryosu icin kaynak tuketimi ve dagitim boyutu acisindan uygun; ayni zamanda capture/serial gibi donanima yakin isleri deterministic yurutmek icin Rust tarafinda daha guvenli bir taban sagliyor.

**Core technologies:**
- Tauri v2 (`tauri` `2.10.3`, `@tauri-apps/api` `2.10.1`, `@tauri-apps/cli` `2.10.1`): desktop shell + native bridge; Windows-first kurulum yolu olgun.
- Rust + Tokio (`tokio` `1.50.0`): capture/serial loop'larinda dusuk gecikmeli ve kontrol edilebilir async orkestrasyon.
- React + Vite + TypeScript (`react` `19.2.4`, `vite` `8.0.1`, `typescript` `5.9.3`): wizard/ayar UX'i icin hizli iterasyon ve tip guvenligi.
- Capture backend'leri (`windows-capture` `1.5.0`, `xcap` `0.9.2`): v1'de Windows optimizasyonu, gelecekte backend swap imkani.
- USB serial (`serialport` `4.9.0`): COM tespit, baglanti yasam dongusu ve platformlararasi seri iletisim.

### Expected Features

v1 icin table-stakes net: gercek zamanli screen mirroring, guvenilir cihaz baglantisi/recovery, layout kalibrasyonu, smoothing/safety kontrolleri, profil yonetimi ve tray operasyonu. Arastirma, bu temel setin eksik oldugu durumda urunun "eksik" algilanacagini gostermekte.

**Must have (table stakes):**
- Real-time screen mirroring + soft color averaging.
- USB auto-detect + manual fallback + reconnect.
- LED layout calibration wizard (start LED, direction, edge counts, gap).
- Profiles + tray controls + basic non-screen modes.

**Should have (competitive):**
- Guided setup + transport saglik dogrulamasi.
- Performance telemetry ve adaptif kalite davranisi.
- Auto black-bar/aspect handling.

**Defer (v2+):**
- Local API/automation hooks.
- Network transport (WLED/UDP/MQTT).
- Advanced effect editor ve plugin marketplace.

### Architecture Approach

Mimari arastirma, core'da state machine kontrollu pipeline desenini "zorunlu" seviyede oneriyor: `idle/capturing/streaming/recovering` oturum durumu, capture ve transport icin adapter arabirimleri, serial icin bounded queue/backpressure, UI-runtime ayrimi. Bu, hem v1 stabilitesini hem de ileride multi-platform/multi-transport genislemesini rewrite olmadan mumkun kilar.

**Major components:**
1. App Shell (tray + wizard + settings) - yalnizca orchestrator API uzerinden kontrol.
2. Runtime Orchestrator - mod/state kaynagi, lifecycle ve recovery politikasi.
3. Capture Engine - monitor secimi ve frame alimi (Windows-first backend).
4. Color Pipeline - zone sampling, calibration, smoothing (I/O'suz testlenebilir cekirdek).
5. Transport + Device Manager - Adalight framing, serial queue, reconnect/health.

### Critical Pitfalls

1. **CPU brute-force capture** - frame budget + dirty rect + erken downsample + telemetry olmadan latency/jank kacınılmaz.
2. **HDR/SDR renk uyumsuzlugu** - capability probe ve ayri HDR yolu (tone-map/gamma) olmadan "washed out" renkler olusur.
3. **Geometri/rotasyon hatalari** - rotation-aware transform ve zorunlu preview adimi olmadan mapping guvenilmez.
4. **Serial throughput saturasyonu** - bytes/frame x FPS butcesi, bounded queue, timeout/retry state machine zorunlu.
5. **Soak/recovery gate eksikligi** - unplug/replug ve sleep/wake testleri olmadan demo calisir, urun bozulur.

## Implications for Roadmap

Based on research, suggested phase structure:

### Phase 1: Runtime Foundations + Device Contract
**Rationale:** Tum sonraki isler stabil domain sozlesmeleri ve cihaz yasam dongusune bagimli.
**Delivers:** Session state machine, profile schema v1, Adalight packet contract, serial device manager (detect/connect/recover).
**Addresses:** Reliable connection/recovery, tray'de dogru durum raporlama.
**Avoids:** Serial throughput mismatch, threading/race kaynakli crashler, port contention.

### Phase 2: Capture + Color Core (Headless Quality)
**Rationale:** UI'den once goruntu kalitesi ve performans fiziklerini izole dogrulamak gerekir.
**Delivers:** Windows capture backend, frame budget/backpressure, zone sampling-calibration-smoothing pipeline, HDR/SDR capability handling.
**Uses:** `windows-capture`, Rust/Tokio worker modeli, telemetry temeli.
**Implements:** Capture engine + color pipeline komponentleri.

### Phase 3: Calibration UX + Profile Workflow
**Rationale:** Core motor hazirken kullanici degeri en hizli wizard ve dogru mapping ile acilir.
**Delivers:** Setup wizard, canli preview, start LED/direction/edge-gap editoru, profile save/load, basic presets.
**Addresses:** LED layout calibration, profiles, basic non-screen modes.
**Avoids:** Geometry/rotation mismatch, jargon nedeniyle setup terk edilmesi.

### Phase 4: End-to-End Realtime Integration + Adaptive Controls
**Rationale:** Ayrik moduller bu fazda tek runtime akisinda birlestirilir ve kalite davranisi stabilize edilir.
**Delivers:** Capture->pipeline->transport entegrasyonu, mode arbitration, black-bar handling, adaptif FPS/coalescing, telemetry paneli.
**Addresses:** Real-time mirroring deneyiminin gunluk kullanim kalitesi.
**Avoids:** Queue sisme/jitter, blackbar flicker, kontrol-data plane karisimi.

### Phase 5: Reliability Gates + Launch Hardening
**Rationale:** v1 basari kriteri ozellik sayisi degil, 1 saat stabilite ve otomatik recovery.
**Delivers:** 60 dk soak suite, fault injection (unplug/replug, sleep/wake, resolution/orientation degisimi), crash-safe diagnostics, guvenli import/validation guardrail.
**Addresses:** "Demo calisiyor ama urun kiriliyor" riskinin kapanmasi.
**Avoids:** Production'da restart zorunlulugu ve destek yukunun patlamasi.

### Phase Ordering Rationale

- Ozellik bagimliliklari real-time mirroring'den once baglanti + kalibrasyon + smoothing gerektiriyor; sira buna gore kuruldu.
- Mimari olarak capture/transport adapter sinirlari erken kuruldugunda v1 kapsaminda yeniden yazim riski azalir.
- Pitfalls dokumanindaki kritik riskler (serial, capture, recovery) ilk 2 ve son faza dagitilarak "erken onlem + gec gate" modeli uygulandi.

### Research Flags

Phases likely needing deeper research during planning:
- **Phase 2:** HDR/SDR donusum stratejisi, Windows capture API secimi (Desktop Duplication vs WGC) ve perf trade-off detaylari.
- **Phase 4:** Black-bar heuristics ve multi-monitor orchestration politikalari; senaryo bazli tuning gerekiyor.
- **Phase 5:** Fault-injection otomasyonu ve kabul esikleri (p95 latency, reconnect SLA) netlestirme.

Phases with standard patterns (skip research-phase):
- **Phase 1:** Serial lifecycle/state machine + packet framing kaliplari iyi dokumante.
- **Phase 3:** Wizard/profile/tray akislari alan icinde oturmus UX ve mimari desenlere sahip.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | Cekirdek secimler resmi dokuman + guncel versiyon kaynaklariyla dogrulandi. |
| Features | MEDIUM | Rekabet analizi kuvvetli ama bazi farklandiricilar daha cok pazar yorumu niteliginde. |
| Architecture | HIGH | Hyperion/Microsoft referanslariyla pipeline ve boundary desenleri tutarli. |
| Pitfalls | MEDIUM-HIGH | Kritik teknik riskler iyi kaynaklanmis; bazi maddeler topluluk issue desenlerinden turetilmis. |

**Overall confidence:** MEDIUM-HIGH

### Gaps to Address

- HDR renk dogrulugu icin nicel hedefler (delta/perceptual kriter) net degil; Phase 2'de test dataset ve kabul metrikleri tanimlanmali.
- V1 icin tek-monitor varsayimi net, ancak P2/P3 planindaki multi-monitor davranis modeli urun karari gerektiriyor; erken policy secimi lazim.
- Firmware varyantlarinda (farkli MCU/baud limitleri) throughput tavanlari degisebilir; Device Compatibility Matrix olusturulmali.
- Telemetry'nin kullaniciya ne kadar acilacagi (debug panel vs auto profile) urunlestirme karari istiyor.

## Sources

### Primary (HIGH confidence)
- Context7 `/tauri-apps/tauri-docs` - Tauri v2 mimarisi, prerequisite ve packaging yonu.
- Context7 `/serialport/serialport-rs` - Serial baglanti, yazma ve hata modeli.
- Microsoft Desktop Duplication API docs - frame acquisition, dirty/move rect, rotation gereksinimleri.
- Microsoft Windows Graphics Capture docs - capture session modeli ve HDR format notlari.
- Hyperion docs + Hyperion.ng repo - Ambilight pipeline, LED layout modeli, Adalight entegrasyon pratikleri.

### Secondary (MEDIUM confidence)
- Context7 `/nashaofu/xcap` - cross-platform capture secenegi ve sinirlari.
- Firefly Luciferin README - telemetry/smoothing/multi-monitor uygulama ipuclari.
- Prismatik/Lightpack README - profile/API ve desktop Ambilight beklenen feature seti.
- Philips Hue ve SignalRGB resmi sayfalari - table-stakes ve rekabet beklentisi dogrulamasi.

### Tertiary (LOW confidence)
- Topluluk issue desenleri (Hyperion issue history) - pitfall sinyali degeri yuksek, ancak urune birebir genellenemez.
- Rakip pazarlama sayfalari (ozellikle feature positioning) - teknik derinlik sinirli, dogrudan implementasyon rehberi olarak kullanilmamali.

---
*Research completed: 2026-03-19*
*Ready for roadmap: yes*
