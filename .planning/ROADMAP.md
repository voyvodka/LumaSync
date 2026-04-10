# Roadmap: LumaSync

## Milestones

- ✅ **v1.0 MVP** — Phases 1-8 (shipped 2026-03-21)
- ✅ **v1.1 Hue Entertainment Integration** — Phases 9-13 (shipped 2026-03-29)
- ✅ **v1.2 Oda Görselleştirme ve Evrensel Işık Yönetimi** — Phases 14-20 (shipped 2026-04-09, v1.0.4)
- 🚧 **v1.3 Kalite & Performans** — v1.1.0-v1.1.1 (shipped 2026-04-09)
- 📋 **v1.4 Backlog** — Aşağıda listelenen çalışma alanları (planlanacak)

---

## Tamamlanan Özellikler (v1.0 — v1.2)

<details>
<summary>v1.0 — USB Ambilight MVP</summary>

- Tray-first shell: tek pencere, tray'e küçült, tray'den aç
- USB serial cihaz keşfi (CH340 / FTDI), auto-reconnect
- LED kalibrasyon editörü: template, kenar sayıları, gap, köşe, başlangıç, yön
- Lighting modları: Off, Ambilight (ekran yakalama), Solid (RGB + parlaklık)
- Runtime telemetri: FPS, frame drop, capture hataları
- EN / TR lokalizasyon
- Auto-updater: GitHub Releases + minisign
- 60 dakika stabilite testi geçti

</details>

<details>
<summary>v1.1 — Hue Entertainment Integration</summary>

- Hue DTLS 1.2 PSK streaming (UDP, port 2100)
- Bridge keşif, eşleştirme, credential doğrulama
- Entertainment area seçimi ve stream lifecycle
- ShutdownSignal, thread death detection, bounded reconnect
- Device settings yeniden tasarım (USB + Hue ayrı kartlar)
- Structured logging (tauri-plugin-log)

</details>

<details>
<summary>v1.2 — Oda Görselleştirme ve Evrensel Işık Yönetimi</summary>

- Contract-first cross-boundary tipler (roomMap.ts, shell.ts, hue.ts)
- DTLS fault recovery, auto-reconnect, telemetri grid
- Hue kanal pozisyon editörü (drag, z-axis slider, multi-select, bridge write-back)
- 2D oda haritası (TV anchor, USB strip, furniture, background image)
- Hue standalone mode (USB şeritsiz çalışma, hot-plug detection)
- LED zone auto-derivation (atan2 algoritma, preview, named zones)
- Target-aware lighting pipeline (delta start/stop)

</details>

<details>
<summary>v1.3 — Kalite & Performans (v1.1.0 — v1.1.1)</summary>

- Tray quick actions: Lights Off / Resume Last / Solid Color (B-06 mini)
- WS2812B gamma 2.2 LUT correction
- User-configurable smoothing/transition speed (B-03)
- Black border detection — letterbox/pillarbox crop (B-05)
- Per-channel EWMA smoothing + continuous position sampling for Hue (B-04)
- Capture performance: SCStream GPU downscale (~640px), Arc zero-copy frame sharing, crop elimination
- Sidebar FPS debug widget (dev builds)
- Quick adjustment fast path (no worker restart on setting tweaks)
- Hue telemetry fix (queue health accuracy in Hue-only mode)
- Windows: calibration overlay DPI, click-through, close interception fixes

</details>

---

## 📋 v1.4 Backlog — Çalışma Alanları

> Güncelleme: 2026-04-10. v1.3 tamamlandı, sırada B-07 ve B-06 tam.

### Uygulama Sırası
1. ✅ ~~B-06 (mini)~~ — Tray quick actions (v1.1.0'da tamamlandı)
2. ✅ ~~Gamma düzeltmesi~~ — WS2812B gamma 2.2 LUT (v1.1.0'da tamamlandı)
3. ✅ ~~B-03~~ — Smoothing / renk geçiş ayarları (v1.1.0'da tamamlandı)
4. ✅ ~~Black border detection~~ — Letterbox/pillarbox algılama (v1.1.0'da tamamlandı)
5. ✅ ~~B-04~~ — Performans + kanal doğruluğu (v1.1.0'da tamamlandı)
6. **B-07** — Oda haritası editörü geliştirme
7. **B-06 (tam)** — Kapsamlı UI redesign (diğer özellikler bitince içerik netleşir)
8. Orta vadeli: Color temperature, Night mode, Black-to-power-off (Hue)
9. Uzun vadeli: Profil sistemi, Config import/export, Efekt motoru, MQTT

---

### B-01: Mevcut Eksiklerin Tespiti
Projede TODO, FIXME, eksik olarak işaretlenmiş tüm alanları tara ve mevcut roadmap ile karşılaştır.

### B-02: Auto-Updater Doğrulaması
Versiyon tespit, latest.json, minisign signature akışının end-to-end doğru çalıştığını doğrula.

### B-03: Ambilight Renk Geçiş Ayarları ✅
Tamamlandı (v1.1.0). EWMA alpha slider (0.05–1.0), AmbilightLiveSettings atomik güncelleme, isQuickAmbilightAdjustment fast path.

### B-04: Ambilight Performans ve Kanal Doğruluğu ✅
Tamamlandı (v1.1.0–v1.1.1). Per-channel EWMA, continuous position sampling, SCStream GPU downscale (~640px), Arc zero-copy, crop eliminasyonu, telemetri fix.

### B-05: Referans Proje ve Rakip Analizi ✅
Analiz tamamlandı (2026-04-09). Incelenenler: Hyperion.NG, Firefly Luciferin, Lightpack/Prismatik, WLED, Govee, Nanoleaf, Hue app.

#### LumaSync Güçlü Yanları (rakiplere göre)
- Hue DTLS entertainment streaming — Firefly/Lightpack'te yok
- Native macOS tray app — Hyperion web UI, Lightpack Qt/eski
- Room map + spatial editor — rakiplerde yok
- Zone auto-derivation — rakiplerde yok
- Kolay onboarding (az adım) — Hyperion/Lightpack karmaşık

#### 🔴 Kritik Feature Gap'ler — ✅ Tümü kapatıldı (v1.1.0)
| Özellik | Referans | Durum |
|---|---|---|
| Gamma düzeltmesi | Hyperion, Firefly, Lightpack | ✅ WS2812B gamma 2.2 LUT |
| Smoothing / renk geçiş ayarları | Tüm rakipler | ✅ B-03 tamamlandı |
| Black border detection | Hyperion, Firefly | ✅ Letterbox/pillarbox algılama |

#### 🟡 Orta Vadeli Feature'lar (vakti var)
| Özellik | Referans | Not |
|---|---|---|
| Color temperature (Kelvin) | Firefly, Lightpack, WLED, Hue | Sıcak/soğuk beyaz — en sona bırakma ama acil değil |
| Night mode / power saving | Firefly | Gece otomatik dim, hareketsizlik timeout |
| Black-to-power-off (Hue) | Hyperion | Siyah frame'de Hue ışıkları kapanmıyor |

#### 🟢 Uzun Vadeli / Backlog (sırası gelince)
| Özellik | Referans | Not |
|---|---|---|
| Profil/preset sistemi | Firefly, Lightpack | Gaming/movie/work profilleri; process-triggered geçiş |
| Config import/export | Hyperion | Yedek alma, paylaşım |
| White temperature / per-hue color grading | Firefly | Lightroom-style 6 kanal HSL — ileride değerlendir |
| Efekt/animasyon motoru | Hyperion (25+ efekt) | Breath, strobe, color cycle |
| Müzik/ses reaktif mod | Firefly, Govee | Beat'e göre renk |
| Çoklu LED protokolü (WLED, Art-Net) | Hyperion | Geniş ekosistem |
| Home Assistant / MQTT | Firefly, Lightpack | Akıllı ev entegrasyonu |

#### UX Pattern'ları (B-06 redesign için)
- **Status-first dashboard** — açılışta "ne açık, hangi renk, bağlı mı?" (Hue, Govee)
- **Aktif rengi UI'a yansıtma** (ambient coloring) — Nanoleaf, Hue
- **Büyük renk-thumbnail preset kartları** — Hue Scene Gallery
- **Quick brightness slider sabit üstte** — WLED, Hue
- **Liveview/peek** — küçük gerçek zamanlı LED önizleme (WLED)

### B-06: UI/UX Kapsamlı Yeniden Tasarım ⭐
**En büyük iş — tartışarak iteratif ilerlemeli.**
- Mevcut tasarım "ayarlar uygulaması" gibi; ışık yönetimi UX'ine uygun değil
- **Açılış ekranı:** Hızlı mod seçimi, önceki modlar, bağlı cihaz/kanal bilgileri, zengin ve kaliteli içerik
- Uygulama bir "ışık kontrol merkezi" gibi hissettirmeli
- Bilgi mimarisi ve kullanım akışı öncelikli (tema/renk ikincil)
- B-05 UX pattern'ları referans alınacak (status-first, ambient coloring, preset kartları)

### B-07: Oda Haritası Editörü Geliştirme
- Layout paneli: yanda tüm objeleri listele
- Obje işlemleri: ekle, kaldır, çoğalt, adını değiştir, konum kilitle
- Resim: ekle, kilitle, yeniden adlandır
- Oda merkezi belirgin + hareket ettirilebilir
- Taşıma sonrası kolay ortalama (snap-to-center)
- Profesyonel seviye editör deneyimi
