# Roadmap: LumaSync

## Milestones

- ✅ **v1.0 MVP** — Phases 1-8 (shipped 2026-03-21)
- ✅ **v1.1 Hue Entertainment Integration** — Phases 9-13 (shipped 2026-03-29)
- ✅ **v1.2 Oda Görselleştirme ve Evrensel Işık Yönetimi** — Phases 14-20 (shipped 2026-04-09, v1.0.4)
- 📋 **v1.3 Backlog** — Aşağıda listelenen çalışma alanları (planlanacak)

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

---

## 📋 v1.3 Backlog — Çalışma Alanları

> Sıralama netleşti (2026-04-09). Adım adım ilerlenecek.

### Uygulama Sırası
1. **B-06 (mini)** — Tray quick actions: Işıkları Kapat / Son Modda Aç / Sabit Renk
2. **Gamma düzeltmesi** — Kritik kalite fix, küçük iş (B-05 analizinden)
3. **B-03** — Smoothing / renk geçiş ayarları (test gerektirir)
4. **Black border detection** — Letterbox/pillarbox algılama (B-05 analizinden)
5. **B-07** — Oda haritası editörü geliştirme
6. **B-06 (tam)** — Kapsamlı UI redesign (diğer özellikler bitince içerik netleşir)
7. Orta vadeli: Color temperature, Night mode, Black-to-power-off (Hue)
8. Uzun vadeli: Profil sistemi, Config import/export, Efekt motoru, MQTT

---

### B-01: Mevcut Eksiklerin Tespiti
Projede TODO, FIXME, eksik olarak işaretlenmiş tüm alanları tara ve mevcut roadmap ile karşılaştır.

### B-02: Auto-Updater Doğrulaması
Versiyon tespit, latest.json, minisign signature akışının end-to-end doğru çalıştığını doğrula.

### B-03: Ambilight Renk Geçiş Ayarları
Hue kanalları için renk geçiş agresifliği (smoothing/transition speed) parametresi. Kullanıcının geçiş yumuşaklığını ayarlayabilmesi.

### B-04: Ambilight Performans ve Kanal Doğruluğu
- Her kanal, ekranın doğru bölgesinden mi renk alıyor?
- Kanal bazlı ayrı ayrı renk gönderme kalitesi
- FPS, latency, capture overhead profiling

### B-05: Referans Proje ve Rakip Analizi ✅
Analiz tamamlandı (2026-04-09). Incelenenler: Hyperion.NG, Firefly Luciferin, Lightpack/Prismatik, WLED, Govee, Nanoleaf, Hue app.

#### LumaSync Güçlü Yanları (rakiplere göre)
- Hue DTLS entertainment streaming — Firefly/Lightpack'te yok
- Native macOS tray app — Hyperion web UI, Lightpack Qt/eski
- Room map + spatial editor — rakiplerde yok
- Zone auto-derivation — rakiplerde yok
- Kolay onboarding (az adım) — Hyperion/Lightpack karmaşık

#### 🔴 Kritik Feature Gap'ler (v1.3 öncelikli)
| Özellik | Referans | Not |
|---|---|---|
| Gamma düzeltmesi | Hyperion, Firefly, Lightpack | WS2812B'de olmadan renkler "yırtık"; LUT eklemek yeterli |
| Smoothing / renk geçiş ayarları | Tüm rakipler | B-03 zaten backlog'da |
| Black border detection | Hyperion, Firefly | Letterbox filmde üst/alt LED'ler gereksiz yanar |

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
