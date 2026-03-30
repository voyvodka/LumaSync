# Phase 15: Fault Recovery and Diagnostics - Context

**Gathered:** 2026-03-30
**Status:** Ready for planning

<domain>
## Phase Boundary

Hue stream'in gecici hatalardan (DTLS dusmesi, ag kesintisi) otomatik kurtarilmasi, hata durumlarinin kodlanmis ve aksiyon verilebilir mesajlarla gosterilmesi, ve telemetry panelinde Hue stream saglik sinyallerinin sunulmasi. Kapsam yalnizca HUE-08, HDR-01, HDR-02 requirement'laridir. Yeni UI sayfalari veya Device section degisiklikleri bu fazin disindadir.

</domain>

<decisions>
## Implementation Decisions

### Otomatik kurtarma davranisi
- **D-01:** Sessiz kurtarma modeli — DTLS/ag kopmasinda status card "Yeniden baglaniliyor..." gosterir, basariliysa sessizce "Running"a doner. Kullanici mudahale etmez, toast/banner/modal yok.
- **D-02:** Retry butcesi tukendiginde (3/3 basarisiz) Failed state'e gecilir, status card "error" varianti gosterir. "Yeniden Dene" ve "Durdur" butonlari sunulur — kullanici karar verir, otomatik durdurma yok.
- **D-03:** Mevcut retry policy korunur: 3 deneme, 400ms-2s exponential backoff. Sinirsiz retry yok.

### Hata mesaji tasarimi (HDR-01)
- **D-04:** Hata mesajlari "Kod + aciklama + aksiyon" formatinda gosterilir. Ornek: `[HUE-NET-01] Bridge ulasilamiyor — Ag baglantinizi kontrol edin`. Status card icinde gosterilir, ayri modal acilmaz.
- **D-05:** Dort hata ailesi kodlanacak:
  - **Ag/baglanti hatalari** — Bridge ulasilamiyor, DTLS handshake basarisiz, timeout
  - **Auth/credential hatalari** — API key gecersiz, bridge eslestirme bozulmus, yeniden pair gerekiyor
  - **Stream runtime hatalari** — Entertainment area bulunamiyor, stream throttle, paket gonderim hatasi
  - **Konfigurasyon hatalari** — Entertainment area secilmemis, bridge IP degismis
- **D-06:** Her hata kodu bir aile prefix'i tasir (HUE-NET-xx, HUE-AUTH-xx, HUE-STR-xx, HUE-CFG-xx) ve en az bir aksiyon ipucu icerir.

### Telemetry Hue saglik sinyalleri (HDR-02)
- **D-07:** Dort metrik grubu telemetry paneline eklenir:
  1. Stream durumu + uptime (Running/Reconnecting/Failed + kac dakikadir aktif)
  2. Paket hizi + son hata (saniyedeki gonderilen paket sayisi, en son hata kodu ve zamani)
  3. Retry sayaci (toplam reconnect denemesi, basarili/basarisiz sayisi)
  4. DTLS baglanti detayi (cipher suite, handshake suresi, baglanti yasi)
- **D-08:** Hue metrikleri mevcut TelemetrySection icine "Hue Stream" alt bolumu olarak eklenir. Ayri panel yok, USB + Hue yan yana tek panelde.
- **D-09:** RuntimeTelemetrySnapshot genisletilir veya ayri HueTelemetrySnapshot eklenir — Rust tarafinda get_runtime_telemetry komutu Hue verilerini de icerecek sekilde genisler.

### Simule edilmis hata tetikleme
- **D-10:** Dev-only Tauri komutu: `simulate_hue_fault` — `#[cfg(debug_assertions)]` ile korunur, uretim build'de bulunmaz. Mevcut dev panelinden (src/dev/) cagrilir.
- **D-11:** Yalnizca DTLS baglanti kopmasi simule edilir (aktif stream'in soket baglantisin zorla kapatarak reconnect tetikler). Bridge ulasilamazlik ve auth gecersizlestirme bu fazda simule edilmez.

### Claude's Discretion
- Hata kodu numaralandirma semasi (HUE-NET-01, 02, ... vs semantic isimler)
- RuntimeTelemetrySnapshot genisletme vs ayri struct karari
- DTLS detay metriklerinin Rust tarafinda nasil toplandigi (openssl binding vs custom tracking)
- Hue telemetry alt bolumunun gorsel layout'u (grid vs liste)

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Hue stream lifecycle
- `src-tauri/src/commands/hue_stream_lifecycle.rs` — Mevcut retry policy, reconnect mantigi, shutdown signal, DTLS connect. Fault recovery bu dosyada genisletilecek.
- `src/features/mode/state/hueModeRuntimeFlow.ts` — Frontend Hue runtime state machine. Reconnecting state'i UI'da nasil handle edildigi burada.

### Hata gosterim modeli
- `src/features/device/hueRuntimeStatusCard.ts` — Mevcut HueRuntimeStatusCardModel: variant, titleKey, bodyKey, actionHints, retry. Hata aileleri buradaki deriveFamilyActionHints() ile eslesiyor.
- `src/shared/contracts/hue.ts` — HUE_STATUS kodlari ve HUE_RUNTIME_ACTION_HINT tipleri. Yeni hata kodlari buraya eklenir.

### Telemetry
- `src/features/telemetry/model/contracts.ts` — Mevcut RuntimeTelemetrySnapshot (captureFps, sendFps, queueHealth). Hue metrikleri icin genisletilecek.
- `src/features/telemetry/ui/TelemetrySection.tsx` — Mevcut telemetry paneli UI. "Hue Stream" alt bolumu buraya eklenir.
- `src-tauri/src/commands/runtime_telemetry.rs` — Rust tarafinda telemetry snapshot toplama. Hue verileri icin genisletilecek.

### Logging
- `src-tauri/src/commands/hue_onboarding.rs` — Onboarding hata kodlari ve CommandStatus pattern'i. Yeni hata aileleri ayni pattern'i takip etmeli.

### Dev tools
- `src/dev/` — Mevcut dev paneli. simulate_hue_fault komutu buradan cagrilacak.

### Phase 10 context (prior decisions)
- `.planning/phases/10-hue-stream-lifecycle/10-CONTEXT.md` — Retry/backoff, stop cleanup, dual-target arbitration kararlari. Bu fazda korunur, degistirilmez.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `HueRuntimeStatusCardModel` (hueRuntimeStatusCard.ts): retry bilgisi gosterimi zaten var — genisletilecek, sifirdan yazilmayacak
- `CommandStatus` struct (hue_onboarding.rs): code/message/details pattern'i tum Hue komutlarinda ortaktir
- `HUE_RUNTIME_ACTION_HINT` (hue.ts): action hint enum'u zaten tanimli, yeni hata aileleri icin genisletilecek
- `TelemetrySection` (TelemetrySection.tsx): mevcut USB metrikleri gosteren panel — Hue alt bolumu eklenir
- `src/dev/` dizini: dev-only araclarin mevcut yeri — simulate komutu buraya entegre edilir

### Established Patterns
- Hata kodlari `HUE_STATUS` const object'inde string literal olarak tanimlanir
- Action hint'ler `HUE_RUNTIME_ACTION_HINT` enum'unda tanimlanir ve StatusCard'da gosterilir
- Telemetry Rust'tan snapshot olarak cekilir (pull-based), push yok
- i18n key'leri `common.json` dosyalarinda EN/TR parity ile tutulur

### Integration Points
- `get_runtime_telemetry` Tauri komutu — Hue metrikleri icin genisletilecek
- `hueRuntimeStatusCard.ts:deriveFamilyActionHints()` — yeni hata aileleri icin case'ler eklenecek
- `hueModeRuntimeFlow.ts` — Reconnecting state UI geri bildirimi

</code_context>

<specifics>
## Specific Ideas

- Sessiz kurtarma: kullanici recovery sirasinda hicbir sey yapmak zorunda kalmamali, status card degisimi yeterli
- Hata kodlari Hue bridge API hata kodlariyla eslesmeli (ornegin bridge 403 → HUE-AUTH-01)
- DTLS fault simulasyonu gercek soket kapatma olmali, sahte state degisikligi degil — gercek reconnect pipeline'ini test etmeli

</specifics>

<deferred>
## Deferred Ideas

- Bridge ulasilamazlik ve auth gecersizlestirme simulasyonlari — gelecek fazlarda veya gelistiricinin ihtiyacina gore eklenebilir
- Frontend log viewer — Phase 13'te defer edildi, bu fazda da kapsam disi
- Multi-bridge fault isolation — v1.2'de tek bridge destegi oldugu icin kapsam disi

</deferred>

---

*Phase: 15-fault-recovery-and-diagnostics*
*Context gathered: 2026-03-30*
