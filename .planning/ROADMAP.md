# Roadmap: LumaSync

## Milestones

> Not: Milestone numaraları (M1, M2...) planlama içindir. Release versiyonları (v1.0.x, v1.1.x) ayrı izlenir.

- ✅ **M1 — USB Ambilight MVP** — Phases 1-8 → release `v1.0` — `v1.0.2` (2026-03-21)
- ✅ **M2 — Hue Entertainment Integration** — Phases 9-13 → release `v1.0.3` (2026-03-29)
- ✅ **M3 — Oda Görselleştirme ve Evrensel Işık Yönetimi** — Phases 14-20 → release `v1.0.4` (2026-04-09)
- ✅ **M4 — Kalite & Performans** — release `v1.1.0` — `v1.1.1` (2026-04-09 — 2026-04-10)
- ✅ **M5 — Room Map Editor (B-07)** — release `v1.2.0` (2026-04-10)
- 🚧 **M6 — UI/UX Redesign (B-06) + Backlog** — planlanacak

---

## Tamamlanan Özellikler (M1 — M5)

<details>
<summary>M1 — USB Ambilight MVP (v1.0 — v1.0.2)</summary>

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
<summary>M2 — Hue Entertainment Integration (v1.0.3)</summary>

- Hue DTLS 1.2 PSK streaming (UDP, port 2100)
- Bridge keşif, eşleştirme, credential doğrulama
- Entertainment area seçimi ve stream lifecycle
- ShutdownSignal, thread death detection, bounded reconnect
- Device settings yeniden tasarım (USB + Hue ayrı kartlar)
- Structured logging (tauri-plugin-log)

</details>

<details>
<summary>M3 — Oda Görselleştirme ve Evrensel Işık Yönetimi (v1.0.4)</summary>

- Contract-first cross-boundary tipler (roomMap.ts, shell.ts, hue.ts)
- DTLS fault recovery, auto-reconnect, telemetri grid
- Hue kanal pozisyon editörü (drag, z-axis slider, multi-select, bridge write-back)
- 2D oda haritası (TV anchor, USB strip, furniture, background image)
- Hue standalone mode (USB şeritsiz çalışma, hot-plug detection)
- LED zone auto-derivation (atan2 algoritma, preview, named zones)
- Target-aware lighting pipeline (delta start/stop)

</details>

<details>
<summary>M4 — Kalite & Performans (v1.1.0 — v1.1.1)</summary>

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

## 📋 M6 Backlog — Çalışma Alanları

> Güncelleme: 2026-04-10. M4 (Kalite) ve M5 (B-07) tamamlandı, sırada B-06 UI/UX Redesign.

### Uygulama Sırası
1. ✅ ~~B-06 (mini)~~ — Tray quick actions (v1.1.0'da tamamlandı)
2. ✅ ~~Gamma düzeltmesi~~ — WS2812B gamma 2.2 LUT (v1.1.0'da tamamlandı)
3. ✅ ~~B-03~~ — Smoothing / renk geçiş ayarları (v1.1.0'da tamamlandı)
4. ✅ ~~Black border detection~~ — Letterbox/pillarbox algılama (v1.1.0'da tamamlandı)
5. ✅ ~~B-04~~ — Performans + kanal doğruluğu (v1.1.0'da tamamlandı)
6. ✅ ~~B-07~~ — Oda haritası editörü geliştirme (tamamlandı, detay: `.planning/b07-room-map-editor/ANALYSIS.md`)
7. **B-06 (tam)** — Kapsamlı UI redesign — **sıradaki ana iş**
8. **LED Preview & Test Experience** — Digital twin overlay, kontrol popup, spiral test pattern (detay: `.planning/led-preview-experience/ANALYSIS.md`)
9. Orta/uzun vadeli özellikler (B-06 redesign ile birlikte veya sonrasında değerlendirilecek)

---

### B-01: Mevcut Eksiklerin Tespiti ✅
Tarandı (2026-04-10): Kodda TODO/FIXME/HACK yok. Tüm bilinen eksikler roadmap'te listelendi.

### B-02: Auto-Updater Doğrulaması ✅
Canlıda end-to-end test edildi (2026-04-10): versiyon tespit, latest.json, minisign signature akışı çalışıyor.
**Açık iş:** Update modal UI geliştirmesi yapılacak (B-06 redesign kapsamında değerlendirilecek).

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

#### UX Pattern'ları → B-06 bölümüne taşındı

### B-06: UI/UX Kapsamlı Yeniden Tasarım ⭐ — SIRADAKİ ANA İŞ
**En büyük iş — tartışarak iteratif ilerlemeli.**

> **Yaklaşım:** Tasarıma başlamadan önce B-05 rakip analizleri ve aşağıdaki özellik listesi referans alınarak
> içerik envanteri çıkarılacak. Neyin tasarlanacağını net görmeden UI'a geçilmeyecek.
> Rakip analizlerine göre eklenecek özellikler belirlendikten sonra tasarım başlayacak.
> Detaylı analiz: `.planning/b07-room-map-editor/ANALYSIS.md` (B-05 rakip UX pattern'ları)

**Temel Prensipler:**
- Mevcut tasarım "ayarlar uygulaması" gibi; ışık yönetimi UX'ine uygun değil
- Uygulama bir "ışık kontrol merkezi" gibi hissettirmeli
- Bilgi mimarisi ve kullanım akışı öncelikli (tema/renk ikincil)

**İçerik Alanları (tasarımda yer alacak):**
- **Açılış ekranı / Dashboard:** Status-first — ne açık, hangi renk, bağlı cihazlar, hızlı mod seçimi
- **Solid mod preset'leri:** Hazır renk kartları (Warm White, Movie Red, Gaming Blue vb.) — tek tıkla seçim
- **Ambilight ayarları:** Mevcut smoothing/gamma/border detection kontrolleri + olası alt modlar
- **Quick brightness slider:** Sabit üstte, her zaman erişilebilir
- **Aktif rengi UI'a yansıtma:** Ambient coloring (Nanoleaf, Hue pattern)
- **Liveview/peek:** Küçük gerçek zamanlı LED önizleme
- **Büyük renk-thumbnail preset kartları:** Hue Scene Gallery pattern
- **Update modal:** Mevcut auto-updater modal UI geliştirmesi

**Orta/Uzun Vadeli Özellikler (B-06 tasarımıyla birlikte veya sonrasında):**
- Bu özellikler B-06 redesign sürecinde UI'da yer alıp almayacaklarına karar verilecek
- Bazıları tasarımda placeholder olarak planlanabilir, implementasyon sonra yapılır
- Detay: aşağıdaki 🟡 Orta Vadeli ve 🟢 Uzun Vadeli tablolar

**B-05 UX Pattern'ları (referans):**
- Status-first dashboard (Hue, Govee)
- Ambient coloring (Nanoleaf, Hue)
- Büyük renk-thumbnail preset kartları (Hue Scene Gallery)
- Quick brightness slider sabit üstte (WLED, Hue)
- Liveview/peek (WLED)

### B-07: Oda Haritası Editörü Geliştirme ✅
Tamamlandı. 11 özellik implemente edildi (detay: `.planning/b07-room-map-editor/ANALYSIS.md`):
Undo/Redo, Object List Panel, Smart Snap Guides, Origin Marker, Context Menu,
Property Bar, Keyboard Shortcuts, Zoom+Pan, Mouse Koordinat, Duplicate, Şablon Sistemi.

**Sonraya bırakılan:** Hue Zone sistemi (zone-relative koordinatlar, çoklu zone, kanal sınırlama).
Detaylı plan memory'de: `project_hue_zone_plan.md`
