# Phase 4: Calibration Workflow - Context

**Gathered:** 2026-03-19
**Status:** Ready for planning

<domain>
## Phase Boundary

Kullanıcı ilk kurulumda otomatik açılan interaktif LED map editor'ü aracılığıyla, sonraki kurulumlarda ise Settings > Calibration bölümünden LED geometri ve yönlendirmeyi kalibre edebilir. Bu faz; LED segment tanımlaması, şablon seçimi, gap konfigürasyonu, başlangıç noktası/yön belirleme ve canlı test pattern doğrulamasını kapsar. Lighting modları (Faz 5), smoothing (Faz 6) ve profil kaydı (v2) bu fazın dışındadır.

</domain>

<decisions>
## Implementation Decisions

### Wizard Tetikleme ve Yüzeyi
- Wizard ilk cihaz bağlantısında otomatik tetikleniyor (kalibrasyon tamamlanmadan LED modu etkinleştirilemez).
- Wizard tam ekran overlay olarak açılıyor — mevcut SettingsLayout'un üstünde çakışmadan çalışır.
- İlk kurulumda ve sonraki düzenlemelerde aynı interaktif LED map editor ekranı kullanılıyor.
- Settings sidebar'a yeni bir "Calibration" bölümü ekleniyor; bu bölüm özet gösterimi + "Düzenle" butonu içeriyor, butona tıklanınca overlay açılıyor.

### LED Map Editor — Görsel Model
- Editör, tam ekran şeffaf overlay üzerinde monitörü çevreleyen LED band'ının görsel temsilini gösteriyor.
- Monitor dört kenar segmente ayrılmış: Top, Left, Right, Bottom.
- Bottom kenar ise Bottom-Left ve Bottom-Right olarak ikiye ayrılabiliyor (aralarında gap değeri — monitör ayağı boşluğu için).
- Her segmentin pixel sayısı ayrı ayrı tanımlanıyor.
- LED başlangıç noktası herhangi bir segmentin başı veya sonunda olabiliyor; segment kenarlarında tıklanabilir başlangıç noktası işaretçileri var.
- Başlangıç noktası seçilince yön (CW/CCW) belirleniyor; diyagramda ok animasyonuyla sıra gösteriliyor.

### Şablon Sistemi
- 5-8 yaygın monitör boyutu hardcoded şablon olarak sunuluyor (örn: 24" 16:9, 27" 16:9, 32" 16:9, 27" QHD, 34" Ultrawide).
- Şablon seçimi zorunlu değil — kullanıcı şablonsuz da başlayabilir (tüm alanlar boş/sıfır gelir).
- Şablon seçilince öneri değerler LED map editor'e yükleniyor; kullanıcı bunları kendi donanımına göre düzenleyebiliyor.
- Tekrar düzenleme sırasında mevcut kaydedilmiş değerler yükleniyor, şablon seçim adımı atlanıyor.
- Kullanıcı isterse "Sıfırla / Şablon seç" butonu ile şablon seçim ekranına dönebiliyor.
- Şablon sistemi v1'de hardcoded; dış dosya/konfig yükleme sonraki faz.

### Canlı Doğrulama (Test Pattern) ve Preview Davranışı
- LED map editor ekranında bir "Test Pattern" toggle/butonu var.
- Çoklu ekran varsa kullanıcı hedef ekranı mini ekran kartları (Display no + çözünürlük/konum) üzerinden seçiyor.
- Test pattern açılınca seçilen ekranda OS-level overlay anında açılıyor; kapanınca overlay tamamen kapanıyor.
- Test pattern açıkken hedef ekran değiştirilirse eski ekrandaki overlay kapanır, yeni seçilen ekranda anında açılır (aynı anda tek aktif overlay).
- Preview görseli app penceresinden bağımsızdır; app küçük olsa da seçilen fiziksel ekranın kenarlarında görünür.
- Seçilen ekranın kenarlarında, her kenar için ayarlanan LED sayısı kadar eşit aralıklı küçük kapsül LED gösterilir.
- Başlangıç ve bitiş LED noktaları işaretli görünür; index etiketi (0 ve N-1) ve akış yönü okları aynı anda gösterilir.
- Kenar LED sayısı, başlangıç, yön ve gap değiştiğinde preview anında (live) güncellenir; Apply adımı yok.
- Renk deneme açıldığında LED kapsüller görünür kalır; arka plan test pattern moduna göre gradient/renk katmanıyla güncellenir.
- V1 test pattern modları: Gradient Flow, Gradient Static, Single Color, Segment Colors.
- V1 test pattern kontrolleri: Mode, hız, parlaklık, renk seçimi.
- Overlay görsel dili: merkez şeffaf kalır; yalnızca kenar katmanında LED kapsüller ve pattern katmanı görünür.
- OS-level overlay açılamıyorsa test pattern bu fazda bloke edilir (fallback preview ile devam edilmez).
- "Kaydet" butonu her zaman görünür; test pattern zorunlu değildir (doğrulama yardımcısıdır).
- Cihaz bağlı değilken editor açılabilir; fiziksel gönderim uygun değilse preview-only statüsü açıkça belirtilir.

### Kalibrasyon Verisi Kalıcılığı
- Kalibrasyon verisi `ShellState`'e yeni bir `ledCalibration?: LedCalibrationConfig` alanı olarak ekleniyor — mevcut plugin-store altyapısı yeniden kullanılıyor.
- Kayıt explicit "Kaydet" butonu ile gerçekleşiyor (otomatik kayıt yok).
- Kaydedilmemiş değişiklikle editörden çıkılmak istenince onay modal'ı gösteriliyor.
- Settings > Calibration bölümü özet bilgi (kaç LED, hangi şablon) + "Düzenle" butonu gösteriyor.

### Claude's Discretion
- Segment pixel sayıları için UI input tasarımı (spinner, sayı alanı vb.).
- Overlay z-index yönetimi ve Tauri pencere katmanlama detayları.
- EN/TR kalibrasyon copy wording (mevcut ton kararlarıyla uyumlu).
- Kaydedilmemiş değişiklik tespiti stratejisi.

</decisions>

<specifics>
## Specific Ideas

- "LED tanımlama işi tek seferde yapılmalı — kullanıcı LED'in başını, sonunu, boşlukları, kenar başına pixel LED sayısını hepsini biraz UI'da görerek yapmalı."
- Alt kenarda monitör ayağı nedeniyle LED bant bölünebiliyor: Bottom-Left ve Bottom-Right ayrı segmentler, ortada gap. Bu gerçek bir kullanım senaryosu olarak tasarımda yer almalı.
- LED map editor şeffaf overlay üzerinde çalışıyor — kullanıcı editörü açıkken arkada ekranını görebiliyor.
- Test pattern: overlay'deki gradient animasyon ile fiziksel LED'lerdeki animasyon eşleşiyor — senkronizasyon doğrulaması için.
- "Preview'i yanlış anlamışsın; seçilen ekranın kenarlarında LED pixel dağılımını net görmek istiyorum" geri bildirimi kilit UX kriteri olarak eklendi.

</specifics>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/shared/contracts/shell.ts`: `SECTION_IDS` ve `SECTION_ORDER` — yeni `CALIBRATION` section ID buraya ekleniyor; downstream module'ler magic string kullanmıyor.
- `src/features/settings/SettingsLayout.tsx`: `SectionContent` switch'e yeni Calibration case eklenecek.
- `src/features/persistence/shellStore.ts` + `src/features/shell/windowLifecycle.ts`: Mevcut `ShellState` persist paterni — `ledCalibration` alanı buraya eklenecek.
- `src/App.tsx`: `lifecycleReady` ve section state burada yönetiliyor — wizard overlay trigger mantığı buraya entegre edilecek.
- `src/features/device/useDeviceConnection.ts`: Cihaz bağlantı durumu buradan okunabilir — wizard'ın "ilk bağlantıda otomatik aç" tetikleyicisi için.
- `src/features/calibration/ui/CalibrationOverlay.tsx`: test pattern toggle, preview chip/segment göstergesi ve canlı state güncellemesi için ana UI yüzeyi.
- `src/features/calibration/state/testPatternFlow.ts`: markerIndex tabanlı preview/physical pattern state orkestrasyonu.
- `src/features/calibration/model/indexMapping.ts`: preview ve fiziksel payload için ortak sequence kaynağı (`buildLedSequence`).

### Established Patterns
- Shell contracts file (`shell.ts`) tek doğruluk kaynağı — tüm yeni ID'ler buraya eklenmeli.
- Frontend/backend iletişimi `invoke` bazlı command bridge üzerinden — kalibrasyon test pattern gönderimi için yeni Rust command gerekecek.
- CSS design tokens + Tailwind v4 — overlay styling için mevcut token sistemi kullanılacak.
- i18n: `src/locales/en/common.json` + `src/locales/tr/common.json` — kalibrasyon copy ikisine de eşit eklenmeli.
- Explicit action-first pattern (Faz 2): test pattern toggle explicit buton ile, otomatik tetikleme yok.
- Quiet-by-default UX tonu (Faz 1-3): kaydet onayı ve bağlantısız mod bildirimi bu tona uygun olmalı.
- Preview ve fiziksel test pattern aynı mapping kaynağından türetilmeli (parity-first karar).

### Integration Points
- `src/App.tsx` → wizard overlay state yönetimi; ilk bağlantı sonrası `hasCalibration` kontrolü.
- `src/shared/contracts/shell.ts` → `SECTION_IDS.CALIBRATION` eklenmesi.
- `src/shared/contracts/shell.ts` → `ShellState` interface'e `ledCalibration` tipi eklenmesi.
- `src/features/settings/SettingsLayout.tsx` → CalibrationSection kaydı.
- `src-tauri/src/commands/` → yeni `calibration.rs` veya mevcut `device_connection.rs` genişletmesi — test pattern gönderimi için.
- `src-tauri/src/lib.rs` → yeni calibration command kaydı.
- `src/locales/en/common.json` + `src/locales/tr/common.json` → kalibrasyon copy.
- `src/features/calibration/ui/CalibrationOverlay.tsx` ↔ ekran seçici UI + OS-level overlay lifecycle kontrolü.
- `src/features/calibration/state/testPatternFlow.ts` ↔ `buildLedSequence` ile marker/sıra parity bağlantısı.

</code_context>

<deferred>
## Deferred Ideas

- Profil kaydetme/yükleme (birden fazla kalibrasyon profili) — v2 PROF-01 gereksinimi.
- Dış JSON/YAML dosyasından şablon yükleme — v1'de hardcoded, sonraki faz genişletilir.
- Çoklu monitör kalibrasyonu — v2 MMON-01 gereksinimi.
- Test pattern modlarına ileri efekt setleri (ek gradient presetleri, daha zengin hareket tipleri) — v1 sonrası genişletme.

</deferred>

---

*Phase: 04-calibration-workflow*
*Context gathered: 2026-03-19*
