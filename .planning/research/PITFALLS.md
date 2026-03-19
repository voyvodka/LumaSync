# Pitfalls Research

**Domain:** Desktop Ambilight app (Windows-first, USB serial, WS2812B)
**Researched:** 2026-03-19
**Confidence:** MEDIUM-HIGH

## Critical Pitfalls

### Pitfall 1: Capture pipeline'i CPU'da brute-force yapmak

**What goes wrong:**
Uygulama tum ekrani her framede CPU'ya cekip full-resolution isliyor; FPS duser, fan sesi artar, input lag ve LED gecikmesi belirginlesir.

**Why it happens:**
Desktop capture'in "goruntu almak" kismina odaklanilip dirty rects/move rects, frame throttling ve GPU tarafinda downsample gibi performans mekanizmalari ihmal edilir.

**How to avoid:**
- Capture katmaninda frame-budget tanimla (ornegin 16.6ms/33ms hedefleri) ve backpressure uygula (eski frame drop, en yeni frame'i isle).
- DXGI Desktop Duplication metadata'sini (dirty/move rect) kullan; tum kareyi her seferinde yeniden isleme.
- Ambilight icin erken downsample yap (LED zonelarina inmeden once GPU'da kucult).
- Perf telemetry'yi ilk gunden ekle: capture ms, process ms, serialize ms, end-to-end latency.

**Warning signs:**
- 1080p/1440p masaustunde CPU ani zirveleri (%20-40+ tek modulde).
- LED tepki suresi gozle hissedilir sekilde "arkadan gelme".
- Isik efektleri acikken UI takilmalari.

**Phase to address:**
Phase 2 (Capture Pipeline) + Phase 4 (Realtime Engine)

---

### Pitfall 2: HDR/renk uzayi farklarini yok saymak (washed out renkler)

**What goes wrong:**
HDR veya advanced color acik sistemlerde Ambilight soluk/yanlis renk verir; kullanici "renkler cansiz" der.

**Why it happens:**
Capture pipeline SDR varsayimiyla (BGRA8) kurulur, tonemap/gamma adimi eklenmez.

**How to avoid:**
- Capture capability probe'da HDR durumunu tespit et; pipeline'i SDR ve HDR yollarina ayir.
- HDR akista 16-bit float format + tonemap/gamma stratejisi tanimla.
- Kalibrasyon ekranina gamma/white balance profili ekle (profil bazli sakla).
- Varsayilan olarak "gorsel olarak daha dogru" preset sagla; advanced panelde ince ayar ac.

**Warning signs:**
- Beyaz sahnelerde LED'ler kirik beyaz/sariya kayiyor.
- SDR icerikte iyi gorunen sistem HDR acilinca bariz bozuluyor.
- Kullanici sikayetleri: "monitorle renkler alakasiz".

**Phase to address:**
Phase 2 (Capture Format Decisions) + Phase 3 (Calibration UX)

---

### Pitfall 3: Ekran geometri/rotasyon/coklu monitor uyumsuzlugu

**What goes wrong:**
LED zonelari yanlis kenarlara duser, portrait/rotated monitorlerde mapping kayar, coklu monitor seciminde tutarsizlik olur.

**Why it happens:**
Masaustu capture'in "goruntu dondurme/monitor bazli koordinat" detaylari goz ardi edilir; yalnizca tek monitor-landscape varsayilir.

**How to avoid:**
- Her monitor icin bagimsiz coordinate transform katmani kur (rotation-aware).
- Wizard'da monitor secimini acik yap; canli overlay onizleme ile mapping dogrulama adimi zorunlu olsun.
- LED layout modeli icin acik source-of-truth: start pixel, direction, edges, corner/gap.
- Multi-monitor fallback politikasi belirle (tek hedef monitor vs birlesik desktop).

**Warning signs:**
- Kullanici "sag kenar solda yaniyor" tipi raporlar.
- Monitor orientation degisince profil bozuluyor.
- Farkli DPI/monitor kombinasyonunda preview ve gercek isik farkli.

**Phase to address:**
Phase 3 (Calibration + Layout Model)

---

### Pitfall 4: Siyah bar/letterbox algisini yanlis sirada uygulamak

**What goes wrong:**
Film iceriginde ust-alt LED'ler ya gereksiz yanar ya tamamen kapanir; cinematic icerikte Ambilight kalitesi ciddi duser.

**Why it happens:**
Black-border detection, crop/resize/layout pipeline'inda dogru noktada uygulanmaz; kamera/overlay kaynakli false positive'ler filtrelenmez.

**How to avoid:**
- Isleme sirasini sabitle: capture -> (gerekirse) crop -> blackbar detect -> zone sample -> smoothing.
- Siyah bar algisini profile bagli yap (threshold + persistence + hysteresis).
- Wizard'da "letterbox test clips" ile otomatik self-check adimi ekle.
- Kamera/yan yansima/duvar parlakligi gibi senaryolarda koruma modu (minimum bar duration) kullan.

**Warning signs:**
- 21:9/2.35:1 icerikte ust-alt LED'lerin aralikli flicker yapmasi.
- Ayni sahnede 5-15 saniyede bir border state degisimi.
- Kullanici blackbar acik olmasina ragmen sapma bildiriyor.

**Phase to address:**
Phase 4 (Color Sampling + Filtering)

---

### Pitfall 5: USB serial throughput'u frame rate hedefiyle esitlenmemek

**What goes wrong:**
LED sayisi ve hedef FPS artinca serial hat doyar; frame queue siser, gecikme buyur, hatta timeout/disconnect gorulur.

**Why it happens:**
"Serial kolay" varsayimiyla baud, payload boyutu ve WS2812 refresh limitleri birlikte hesaplanmaz.

**How to avoid:**
- Erken donemde bant-genisligi butcesi cikar: bytes/frame * fps <= efektif serial throughput.
- Adaptif FPS veya adaptif zone cozumleme ekle (cihaz kapasitesine gore degrade).
- Binary framing + checksum + kisa ack/nack stratejisi kullan; write timeout ve retry politikasi belirle.
- Port ac/kapa/disconnect durumlari icin state machine yaz (Connecting/Streaming/Recovering).

**Warning signs:**
- Yukseldiginde artan end-to-end latency, sonra ani "catch-up" davranisi.
- COM portta aralikli write timeout veya yeniden baglanma dongusu.
- LED sayisi arttikca "flicker + stop + resume" paterni.

**Phase to address:**
Phase 1 (Device Protocol Contract) + Phase 4 (Transport Runtime)

---

### Pitfall 6: WS2812B elektrik gerceklerini goz ardi etmek (guc/voltaj dusumu)

**What goes wrong:**
Uzak LED'lerde renk kahverengiye kayar, rastgele glitch/flicker olur, bazen ilk piksel hasari gorulur.

**Why it happens:**
Yetersiz PSU, guc enjeksiyonsuz uzun hat, data hattinda direnc/kapasitor eksikligi, zayif ground tasarimi.

**How to avoid:**
- Kurulum rehberine zorunlu donanim checklist'i koy: ortak GND, data resistor, bulk capacitor, guc enjeksiyon noktasi.
- LED sayisina gore PSU secim hesabi ver (worst-case ve tipik kullanim ayrimiyla).
- Wizard/diagnostics'te "power suspicion" sinyali uret (beyaz testte drop/flicker).
- Profilde global brightness cap varsayilanini guvenli baslat (ornegin %40-%60).

**Warning signs:**
- Tam beyaz testte sadece son bolumlerde renk bozulmasi.
- Uzun seanslarda artan kararsizlik (isinma ile kotulesme).
- "Bazen ilk LED bozuldu" veya zincir ortasindan sonrasi kapandi raporlari.

**Phase to address:**
Phase 1 (Hardware Setup Guardrails) + Phase 5 (Diagnostics)

---

### Pitfall 7: Threading ve event modelini yanlis kurmak (UI freeze / crash)

**What goes wrong:**
Serial/capture eventleri UI thread'ine kontrolsuz tasinir; app donmasi, race condition, zor yakalanan crashler ortaya cikar.

**Why it happens:**
DataReceived/ErrorReceived gibi eventlerin sirasiz/gecikmeli/arka thread'de geldigi gercegi goz ardi edilir.

**How to avoid:**
- UI ile runtime motorunu ayir: message queue/actor benzeri tek-yazar model.
- Tum IO eventlerini "ingest -> normalize -> dispatch" pipeline'inda serialize et.
- Cancellation token + supervised background worker yapisi kur.
- Crash-safe telemetry: son N olay, port state, capture state ring buffer.

**Warning signs:**
- Nadiren tekrar eden ama kaynagi belirsiz crashler.
- Port reconnect sirasinda UI'nin yanit vermemesi.
- Ayni bugun farkli stack trace'lerle gorunmesi.

**Phase to address:**
Phase 1 (Runtime Architecture) + Phase 5 (Stability Hardening)

---

### Pitfall 8: "Demo calisiyor" seviyesinde kalip 1 saat stabiliteyi test etmemek

**What goes wrong:**
5 dakikalik demo sorunsuz gorunur ama uzun kullanimda memory buyumesi, capture reset, port drop, jitter birikir.

**Why it happens:**
Erken asamada soak test, fault injection ve recoverability kriterleri backlog'a atilir.

**How to avoid:**
- Baslangictan itibaren 60 dakikalik soak test senaryosunu release gate yap.
- Zorlayici testler ekle: USB unplug/replug, monitor sleep/wake, resolution change, fullscreen app transition.
- Her hatadan sonra otomatik recovery sure ve basari metriği topla.
- "No-crash" ve "graceful degradation" icin acik kabul kriterleri tanimla.

**Warning signs:**
- 20-40 dakika sonra frame drops artiyor.
- Sleep/wake sonrasi capture geri donmuyor.
- Kullanici workaround olarak app restart etmek zorunda kaliyor.

**Phase to address:**
Phase 5 (Reliability + QA Gates)

---

## Technical Debt Patterns

Shortcuts that seem reasonable but create long-term problems.

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Tum frame'i CPU'da islemek | Hızlı prototip | Yuksek latency ve fan/CPU sikayeti | Sadece ilk spike prototipte, max 1-2 gun |
| Tek "magic" smoothing ayari | Basit UI | Farkli icerikte ya flicker ya gecikme | MVP'de 2 preset ile gecici |
| Port hatalarinda sadece auto-restart | Cok hizli kurtarma hissi | Sonsuz reconnect loop, debug zorlasir | Asla tek basina degil |
| Layout'u sadece drag-drop offset olarak saklamak | Kod kisa | Profil tasinabilirligi ve tekrar kalibrasyon sorunu | Asla; semantik model gerekir |

## Integration Gotchas

Common mistakes when connecting to external services/devices.

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| Windows capture API | Rotation/HDR/device-lost path'lerini atlamak | Capture abstraction'inda bu durumlari first-class state yap |
| USB Serial (COM) | Write timeout/backpressure yok | Bounded queue + timeout + reconnect state machine uygula |
| WS2812B strips | Tek noktadan guc verip uzun hatta devam etmek | Coklu guc enjeksiyonu + ortak GND + cap/resistor standardi koy |

## Performance Traps

Patterns that work at small scale but fail as usage grows.

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| LED zonelarini fazla ince tutmak | Serial doluluk ve jitter | Zone sayisini ekran boyutu yerine algisal faydaya gore sinirla | 150+ LED ve 30+ FPS hedeflerinde belirgin |
| Her frame'i gondermek (frame coalescing yok) | Queue birikimi, gecikme artisi | En yeni frame stratejisi + delta/threshold gonderim | Hareketli sahnelerde dakikalar icinde |
| Smoothing'i capture'dan sonra degil output'ta uygulamak | Renk dogrulugu bozulur | Sampling->color pipeline sonrasinda temporal smoothing uygula | Karanlik-gecisli sahnelerde hemen |

## Security Mistakes

Domain-specific security issues beyond general web security.

| Mistake | Risk | Prevention |
|---------|------|------------|
| Firmware/profil importunu dogrulamadan calistirmak | Kotu niyetli payload ile cihaz/uygulama kararsizligi | Signed/validated profile schema, strict parser, safe defaults |
| Yerel API/IPC'yi sinirsiz acmak | Lokal kotuye kullanim, isik kontrolunun ele gecmesi | Localhost-scope, explicit auth token, command allowlist |
| Loglara ham ekran/cihaz bilgisi yığmak | Gizlilik ihlali (icerik metadata) | Redaction + opt-in diagnostic paketleri |

## UX Pitfalls

Common user experience mistakes in this domain.

| Pitfall | User Impact | Better Approach |
|---------|-------------|-----------------|
| Wizard'da teknik jargon (baud, gamma, threshold) ile baslamak | Kurulum yarida birakilir | Once sonuc odakli adimlar, advanced ayar sonradan |
| Canli preview olmadan layout kalibrasyonu | Deneme-yanilma ve hayal kirikligi | Her adimda edge highlight ve test pattern onizleme |
| "Connected" ama gercekte stream yok durumu | Kullanici neyin bozuk oldugunu anlayamaz | Cihaz durumu: Connected / Streaming / Degraded / Reconnecting ayrimi |

## "Looks Done But Isn't" Checklist

Things that appear complete but are missing critical pieces.

- [ ] **Realtime Ambilight:** Sadece "goruntu geliyor" degil; 60 dakika soak + unplug/replug geciyor mu?
- [ ] **Calibration:** Sadece kaydetme degil; monitor rotation degisince profil tutarli mi?
- [ ] **Serial Transport:** Sadece yazma degil; timeout/backpressure metrikleri var mi?
- [ ] **Color Quality:** Sadece SDR dogru degil; HDR acik sistemde de kabul edilebilir mi?
- [ ] **Recovery:** Sadece restart degil; app kendisi recover edip stream'e donebiliyor mu?

## Recovery Strategies

When pitfalls occur despite prevention, how to recover.

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| Capture pipeline overload | MEDIUM | FPS/zoning'i runtime'da dusur, perf-profile kaydet, kullaniciya "balanced mode" oner |
| Serial saturation/disconnect loop | MEDIUM | Queue drain et, port state reset, baud/payload preset downgrade uygula |
| Power/voltage instability | HIGH | Test pattern ile fault isolate et, guc enjeksiyon ve PSU rehberiyle yeniden kurulum yaptir |
| Mapping mismatch | LOW-MEDIUM | Profil rollback + hizli edge-by-edge recalibration wizard'i calistir |

## Pitfall-to-Phase Mapping

How roadmap phases should address these pitfalls.

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| Capture brute-force | Phase 2 + 4 | Telemetry'de capture/process p95 hedef altinda, UI jank yok |
| HDR/color mismatch | Phase 2 + 3 | SDR/HDR test setinde delta kabul araliginda |
| Geometry/rotation mismatch | Phase 3 | 0/90/180/270 rotasyon testlerinde edge mapping dogru |
| Blackbar instability | Phase 4 | Letterbox kliplerde ust-alt LED false trigger olmuyor |
| Serial throughput mismatch | Phase 1 + 4 | Hedef LED+FPS kombinasyonunda timeout olmadan 60 dk calisiyor |
| WS2812B power mistakes | Phase 1 + 5 | Beyaz test + uzun seanslarda flicker/renk kaymasi yok |
| Threading/race crashes | Phase 1 + 5 | Reconnect ve sleep/wake fault testlerinde crash 0 |
| No soak/recovery gate | Phase 5 | CI/manual gate: 1 saat stabilite + fault-injection senaryolari pass |

## Sources

- Microsoft Desktop Duplication API (dirty/move rect, rotation): https://learn.microsoft.com/en-us/windows/win32/direct3ddxgi/desktop-dup-api (HIGH)
- Microsoft Windows Graphics Capture (HDR format guidance, frame pool handling): https://learn.microsoft.com/en-us/windows/uwp/audio-video-camera/screen-capture (HIGH)
- Microsoft SetWindowDisplayAffinity (capture exclusion/protection behavior): https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwindowdisplayaffinity (HIGH)
- .NET SerialPort DataReceived/ErrorReceived/Write semantics (event order, secondary thread, timeout):
  - https://learn.microsoft.com/en-us/dotnet/api/system.io.ports.serialport.datareceived (HIGH)
  - https://learn.microsoft.com/en-us/dotnet/api/system.io.ports.serialport.errorreceived (HIGH)
  - https://learn.microsoft.com/en-us/dotnet/api/system.io.ports.serialport.write (HIGH)
- Adafruit NeoPixel Uberguide (power distribution, capacitor/resistor, voltage-drop, timing limits):
  - https://learn.adafruit.com/adafruit-neopixel-uberguide/best-practices (MEDIUM-HIGH)
  - https://learn.adafruit.com/adafruit-neopixel-uberguide/powering-neopixels (MEDIUM-HIGH)
  - https://learn.adafruit.com/adafruit-neopixel-uberguide/advanced-coding (MEDIUM)
- Hyperion issue history (community failure patterns for blackbar/perf/instability):
  - https://github.com/hyperion-project/hyperion.ng/issues/1030 (MEDIUM)
  - https://github.com/hyperion-project/hyperion.ng/issues/1278 (MEDIUM)
  - https://github.com/hyperion-project/hyperion.ng/issues/713 (MEDIUM)

---
*Pitfalls research for: Desktop Ambilight app ecosystem*
*Researched: 2026-03-19*
