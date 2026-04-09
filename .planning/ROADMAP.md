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

> Bu liste henüz fazlara ayrılmadı. Her madde tartışılarak detaylandırılacak ve sıralanacak.

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

### B-05: Referans Proje ve Rakip Analizi
Expert agentlardaki GitHub referans projelerini incele. Benzer uygulamalarda hangi özellikler var? Feature gap analizi.

### B-06: UI/UX Kapsamlı Yeniden Tasarım ⭐
**En büyük iş — tartışarak iteratif ilerlemeli.**
- Mevcut tasarım "ayarlar uygulaması" gibi; ışık yönetimi UX'ine uygun değil
- **Açılış ekranı:** Hızlı mod seçimi, önceki modlar, bağlı cihaz/kanal bilgileri, zengin ve kaliteli içerik
- Uygulama bir "ışık kontrol merkezi" gibi hissettirmeli
- Bilgi mimarisi ve kullanım akışı öncelikli (tema/renk ikincil)

### B-07: Oda Haritası Editörü Geliştirme
- Layout paneli: yanda tüm objeleri listele
- Obje işlemleri: ekle, kaldır, çoğalt, adını değiştir, konum kilitle
- Resim: ekle, kilitle, yeniden adlandır
- Oda merkezi belirgin + hareket ettirilebilir
- Taşıma sonrası kolay ortalama (snap-to-center)
- Profesyonel seviye editör deneyimi
