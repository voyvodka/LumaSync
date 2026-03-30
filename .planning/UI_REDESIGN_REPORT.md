# LumaSync UI/UX Yeniden Tasarim Raporu

> Tarih: 2026-03-30
> Kapsam: Tam UI analizi + navigasyon yeniden yapilandirma + ekran bazli oneriler + uygulama plani
> Hedef: Yeni bir sohbette adim adim uygulanabilir, somut aksiyon listesi

---

## BOLUM 1: Mevcut Durum Analizi

### 1.1 Genel Mimari Gorunum

Uygulama 3 ust seviye bolume ayrilmis (Control, Calibration, Settings). Settings icinde 3 alt sekme var (Device, System, Diagnostics). Toplam 6 farkli icerik alani 900x620 px pencereye sigdirilmaya calisiyor.

**Mevcut navigasyon agaci:**

```
Sidebar (sol)
  +-- Control (GeneralSection)
  +-- Calibration (CalibrationPage - 3 adimli wizard)
  +-- Settings (SettingsPage)
        +-- [Tab] Device (DeviceSection: USB + Hue wizard)
        +-- [Tab] System (Dil, Startup, Hakkinda, Guncelleme)
        +-- [Tab] Diagnostics (TelemetrySection)
```

### 1.2 Ekran Bazli Sorunlar

#### Control Ekrani (GeneralSection)
- **Bilgi hiyerarsisi duzgun degil**: OutputTargetsPanel, durum gostergesi olarak iyi calisiyor ama "neden unavailable?" sorusuna cevap vermiyor. USB bagli degilse sadece soluk goruyor, nereye gidecegini bilmiyor.
- **Mod secici basit ve islevsel** ama Off/Ambilight/Solid butonlari arasinda gorsel fark yok -- aktif mod sadece renk farki ile anlasilabiliyor, ikon veya gorsel ipucu yok.
- **CalibrationRequiredBanner** yalnizca kalibrasyon eksikse gorunuyor, bos state (hicbir cihaz bagli degil, hicbir sey konfigure edilmemis) icin ozel bir deneyim yok.
- **SolidColorPanel** yalnizca Solid modda aciliyor -- iyi, ama acilma/kapanma animasyonu yok, ani gorunup kaybolma hissi var.

#### Device Sekmesi (Settings > Device > DeviceSection)
- **En buyuk sorun: Erisim derinligi.** USB cihaz baglantisi ve Hue kurulumu uygulamanin en kritik onboarding akislarindan biri, ama 2 tik gerektiriyor (Settings > Device).
- **Port listesi iki sutunlu grid** (`sm:grid-cols-2`) 900px pencerede iyi gorunuyor ama icerik buyudugunde (3+ port + status card + Hue wizard) dikey tasmaya neden oluyor.
- **Status card her zaman gorunuyor** -- Idle durumda bile "Waiting for a selection" kart gorunur, gereksiz alan tuketir.
- **Health Check ayrimi belirsiz** -- Refresh ve Health Check butonlari yan yana, kullanici farkini anlamiyor.
- **Hue wizard accordion** iyi calisyor ama:
  - Ready adimi icerigi neredeyse bos, sadece ozet gosteriyor
  - Offline card (bridgeUnreachable) buyuk ve dominasyon kuruyor, wizard'i asan gorsel agirlik
  - Channel Map Panel alt alta uzayan bir yapida, dikey alan israfi ciddi

#### Calibration (CalibrationPage)
- **Wizard yapisinda geri butonu eksik**: Step indicator tiklanabilir (done olanlara) ama acik bir "<- Geri" butonu yok, navigasyon kesfedilebilir degil.
- **Display secim adimi validasyonsuz gecise izin veriyor**: Kullanici hicbir display secmeden "Continue" diyerek editor'e gecebiliyor.
- **Template adiminda "Skip" secenegi** lokalizasyon dosyasinda var (`calibration.template.skip`) ama UI'da gorunmuyor gibi (CalibrationTemplateStep icerigi ayri dosyada).
- **Preview toggle + action bar** alt kisimda sabit -- iyi karar, ama test pattern durumu ile ana action butonlari ayni satirda, gorsel kalabalik.

#### System Sekmesi (Settings > System > SystemTab)
- **"Minimize on close - Always on" badge'i gereksiz satir kapliyor**: Bu zaten tray-first uygulamada degistirilemez, ayri toggle gibi gorunmesi yaniltici.
- **Log row aksiyonsuz**: "Logs" satirinda ne expand, ne download, ne "Open in Finder" butonu var. Bilgi veriyor ama hicbir ise yaramiyor.
- **Guncelleme kontrolu "About & Logs" bolumunun icinde gomulu**: Kullanici guncellemeleri aramak icin About altina bakmaz. Ayrica modal zaten otomatik cikiyor, bu satir yari gereksiz.
- **Language secici kendi baslik + aciklamasi ile bir bolum kaplyor**: 2 buton icin `SectionHeader` + aciklama + radio group = 4 satir dikey alan.
- **Bolumler arasi `divide-y` ile ayrilmis** ama bolum basina padding farkli (py-5), hissiyat tutarsiz.

#### Diagnostics/Telemetri (TelemetrySection)
- **750ms polling intervali cok agresif**: Kullanici bu sekmeyi acik tutmazsa bile poll devam ediyor (component mount oldugu surece). Sekme kapaninca unmount oluyor, ama acikken CPU/network israfi var.
- **3 metrik kart yatayda esit bolunmus** (grid-cols-3) ama "Queue Health" metin bazli, FPS sayisal -- gorsel hiyerarsi esit ama bilgi yogunlugu esit degil.
- **Tek basina sekme olarak yeterli icerik tasiyip tasimadigina dair sorular**: 3 kart + bos state + error state. Ileride genisleyecekse tamam, ama su an icin baska bir yere gomulup kurtarilamaz mi?

---

## BOLUM 2: Navigasyon Yeniden Yapilandirma

### 2.1 Mevcut Yapinin Sorunlari

1. **Derinlik sorunu**: USB cihaz baglantisi ve Hue kurulumu Settings > Device altinda. Kullanici ilk acilista bu ekranlara 2 tikla ulasiyor. Tray-first uygulamada her sey 1 tikla erisilmeli.

2. **Settings catch-all olmus**: Device (donanim kurulumu), System (dil/startup/hakkinda), Diagnostics (runtime telemetri) -- ucunde ortak olan tek sey "sik degistirilmeyen seyler" ama Device aslinda onboarding'in cekirdegi.

3. **Calibration ve Control ayri ama semantik olarak ilikili**: Kullanici "isiklari ac" demek icin Control'e gidiyor, kalibrasyon gerekiyorsa Calibration'a yonlendiriliyor, sonra Control'e geri geliyor. Bu gecis mantikli ama baglam kaybi olusturuyor.

4. **Tab bar (Settings icindeki) kesfedilebilirlik sorunu**: Settings'e giren kullanici ilk Device'i goruyor, System ve Diagnostics icin sekme degistirmesi gerekiyor. Tab bar gorsel olarak muted, atlaniyor.

### 2.2 Onerilen Yeni Yapi

**Secenek A: 4 ust seviye bolum (ONERILEN)**

```
Sidebar (sol)
  +-- Isiklar (Control)         -- Su anki GeneralSection + cihaz durumu ozeti
  +-- LED Kurulumu (Calibration) -- Su anki CalibrationPage wizard
  +-- Cihazlar (Devices)         -- USB + Hue kurulumu (su anki DeviceSection)
  +-- Sistem (System)            -- Dil, Startup, Telemetri, Guncelleme, Hakkinda
```

**Avantajlari:**
- Cihaz kurulumu 1 tika iniyor (en kritik iyilestirme)
- Her bolum net bir amaca hizmet ediyor: "Isik kontrol et", "LED'leri konfigure et", "Donanimi bagla", "Uygulamayi ayarla"
- Sidebar 4 madde ile hala kompakt (900px pencerede 48px yuksekliginde itemlar = 192px, gayet rahat)
- Telemetri System altina tasiniyor, tek basina sekme olmak yerine alt bolum oluyor
- Settings > Device > ... yolculugu ortadan kalkiyor

**Dezavantajlari:**
- Sidebar 3'ten 4'e cikiyor (ama hala 5'in altinda, tray-first icin kabul edilebilir)
- `shell.ts` contractlarinin guncellenmesi gerekiyor (SECTION_IDS, SECTION_ORDER)
- Mevcut persistence'daki `lastSection` migration gerektirecek

**Secenek B: 3 ust seviye, Device'i Control'e entegre et**

```
Sidebar (sol)
  +-- Ana Panel (Control + cihaz durumu + hizli aksiyonlar)
  +-- LED Kurulumu (Calibration)
  +-- Ayarlar (Dil, Startup, Telemetri, Hakkinda + Device detaylari)
```

Bu secenekte Control ekraninda cihaz durumu ozeti + "Cihazlari Yonet" butonu bulunur, Device detaylari hala Settings altinda kalir.

**Dezavantajlari:**
- Device hala 2 tik (Control > "Yonet" butonu veya Settings > Device)
- Control ekrani cok karisik olur

**Karar: Secenek A onerilir.**

### 2.3 Yeni Navigasyon Detaylari

#### Sidebar Yapisi

| Sira | ID | Ikon | Etiket (EN) | Etiket (TR) | Icerik |
|---|---|---|---|---|---|
| 1 | `lights` | Gunes/isik ikonu | Lights | Isiklar | Mod secici, output targets, solid color, durum ozeti |
| 2 | `led-setup` | Monitor + LED ikonu | LED Setup | LED Kurulumu | Template > Display > Editor wizard |
| 3 | `devices` | USB + Hue ikonu | Devices | Cihazlar | USB port yonetimi + Hue onboarding wizard |
| 4 | `system` | Gear ikonu | System | Sistem | Dil, Startup, Telemetri, Guncelleme, Hakkinda |

#### Contract Degisiklikleri (shell.ts)

```typescript
export const SECTION_IDS = {
  LIGHTS: "lights",
  LED_SETUP: "led-setup",
  DEVICES: "devices",
  SYSTEM: "system",
} as const;

export const SECTION_ORDER: SectionId[] = [
  SECTION_IDS.LIGHTS,
  SECTION_IDS.LED_SETUP,
  SECTION_IDS.DEVICES,
  SECTION_IDS.SYSTEM,
];

// SETTINGS_TAB_IDS artik gerekmiyor - kaldirilabilir
// veya System bolumunun alt bolumleri icin yeniden tanimlanabilir
```

#### Migration Stratejisi

`loadShellState()` icindeki sectionMap zaten eski ID'leri yeni ID'lere mapliyor. Bu pattern genisletilecek:

```typescript
const sectionMap: Record<string, SectionId> = {
  // Eski ID'ler
  control: SECTION_IDS.LIGHTS,
  general: SECTION_IDS.LIGHTS,
  calibration: SECTION_IDS.LED_SETUP,
  device: SECTION_IDS.DEVICES,
  settings: SECTION_IDS.SYSTEM,
  "startup-tray": SECTION_IDS.SYSTEM,
  language: SECTION_IDS.SYSTEM,
  "about-logs": SECTION_IDS.SYSTEM,
  telemetry: SECTION_IDS.SYSTEM,
  // Yeni ID'ler (kendilerine map)
  lights: SECTION_IDS.LIGHTS,
  "led-setup": SECTION_IDS.LED_SETUP,
  devices: SECTION_IDS.DEVICES,
  system: SECTION_IDS.SYSTEM,
};
```

---

## BOLUM 3: Ekran Bazli Tasarim Onerileri

### 3.1 Isiklar Ekrani (su anki Control / GeneralSection)

#### 3.1.1 Output Targets Paneli

**Mevcut sorun:** Chip'ler toggle gibi calisiyor ama durum bilgisi yetersiz. USB "Not connected" ise chip soluk ama neden ve ne yapmali bilgisi yok.

**Oneriler:**
- Her chip'in altina tek satirlik durum metni ekle: "Connected on /dev/cu.usbserial" veya "Not connected -- go to Devices"
- Chip'ler arasi ayirici yerine card yapisi kullan: her device bir kucuk kart, sol tarafta durum dot, sag tarafta toggle
- "Hue" chipi icin streaming durumunda pulse animasyonu mevcut (iyi), ama "configured but not reachable" durumunda amber dot + "Unreachable" metni gosterilmeli

**Oneri tasarimi:**

```
+------------------------------------------+
| OUTPUT TARGETS                           |
|                                          |
| [*] USB LED Strip        Connected       |
|     /dev/cu.usbserial-110               |
|                                          |
| [ ] Philips Hue          Unreachable     |
|     Living Room Bridge                   |
+------------------------------------------+
```

#### 3.1.2 Mod Secici

**Mevcut sorun:** 3 buton yan yana, gorsel olarak duzgun ama "Off" butonunun diger ikisiyle ayni agirlikta olmasi yaniltici. Off bir "aksiyon" (kapat), digerleri "mod" (sec).

**Oneriler:**
- Off butonunu ayir: sol tarafta kucuk bir "power off" ikonu ile ayricalikli konum
- Ambilight ve Solid butonlarina kucuk ikon ekle (dalga ikonu, daire ikonu)
- Aktif mod icin subtle glow veya border-glow efekti (accent renkle)
- Mod gecisi sirasinda `isModeTransitioning` icin butonlarda skeleton/pulse efekti

#### 3.1.3 CalibrationBanner

**Mevcut sorun:** Yalnizca kalibrasyon yokken gorunuyor. Bos state (hicbir sey konfigure edilmemis) icin deneyim yok.

**Oneriler:**
- 3 katmanli durum sistemi:
  1. **Hicbir cihaz bagli degil**: "Connect a device to get started" + "Go to Devices" butonu
  2. **Cihaz bagli, kalibrasyon yok**: Mevcut CalibrationRequiredBanner (korunsun)
  3. **Her sey hazir**: Banner yok, dogrudan mod secici

#### 3.1.4 SolidColorPanel Gecisi

- `transition-all duration-200` ile acilma/kapanma animasyonu ekle
- Panel acilirken height animasyonu icin `grid-rows-[0fr] -> grid-rows-[1fr]` pattern'i kullan (CalibrationPage'deki accordion ile ayni)

### 3.2 Cihazlar Sekmesi (su anki Settings > Device > DeviceSection)

#### 3.2.1 Port Listesi

**Mevcut sorun:** 2 sutunlu grid (Supported / Other) her zaman goruluyor. Cogu kullanicida 0-1 supported port ve 0-2 other port olacak. Grid yaklasimi alan israf ediyor.

**Oneriler:**
- Tek liste, grup basliklari ile: "Supported Controllers" alt basligi, ardindan portlar, sonra "Other Ports" alt basligi
- Bos gruplari tamamen gizle (dashed border empty state'i kaldır)
- Port sayisi 3'ten fazlaysa scrollable alan, degilse tam gorunum

#### 3.2.2 Status Card

**Mevcut sorun:** Idle durumda bile "Waiting for a selection" kart gorunuyor. 4 satir yer kapliyor, bilgi degeri sifir.

**Oneriler:**
- Idle durumda status card'i gizle (veya tek satirlik inline mesaja dusur)
- Yalnizca aktif durumlarda goster: connected, error, reconnecting, health check result
- Health check sonuclari icin expandable/collapsible yapi (default collapsed)

#### 3.2.3 "Ready" Adimi (Hue Wizard)

**Mevcut sorun:** Hue wizard'da 4. adim "Ready" -- ama icerigi neredeyse bos, sadece ozet. Kullanici "Ready" dediginde ne yapmali belirsiz.

**Oneriler:**
- "Ready" adimini kaldır, yerine wizard tamamlandiginda header badge'i "Ready" gostersin ve ozet bilgi inline olarak area adimin sonuna eklensin
- Veya "Ready" adimini "Connection Test" olarak yeniden tanimla: gercek bir baglanti testi calistirilsin

#### 3.2.4 Offline Card Boyutu

**Mevcut sorun:** bridgeUnreachable durumunda gosterilen offline card gorsel olarak cok buyuk (icon + title + body + 3 reason + 2 buton + reset link). Wizard'in ustunde dominasyon kuruyor.

**Oneriler:**
- Compact versiyona gec: tek satirlik uyari + "Rediscover" butonu, detaylar expandable
- Veya wizard step 1 (Discover) icinde inline olarak goster, ayri card olmaktan cikar

#### 3.2.5 Dikey Alan Israfi

**Genel sorun:** DeviceSection icinde USB bolumu + Hue bolumu alt alta, her birinin header + content + status card yapisi var. 900x620 pencerede scroll gerekli oluyor.

**Oneriler:**
- USB ve Hue'yu tab veya accordion yapisina al (biri acikken digeri kapali)
- Veya USB'yi compact card'a dusur (1 port secili + connect butonu), Hue wizard'i ana icerik alanini kullansın

### 3.3 Kalibrasyon (CalibrationPage)

#### 3.3.1 Wizard Geri Butonu

**Mevcut sorun:** Step indicator tiklanabilir (done olanlara) ama acik bir geri butonu yok. Kullanici bu kesfetmesi gereken bir interaksiyonu bilmeyebilir.

**Oneriler:**
- Her adimda (display ve editor) sol alt koseye "<- Back" butonu ekle (action bar'a)
- Step indicator tiklanabilirligi korunsun ama geri butonu birincil navigasyon araci olsun

#### 3.3.2 Display Adimi Validasyonu

**Mevcut sorun:** "Continue" butonu display secilmeden de aktif. Kullanici hicbir display secmeden editor'e gecebiliyor.

**Oneriler:**
- Display secilmeden "Continue" butonunu disable et
- Veya: display listesi 1 eleman iceriyorsa otomatik sec (cogu kullanicida tek monitor)

#### 3.3.3 Navigasyon Yapısındaki Yeri

Calibration su an ust seviye bolum. Yeni yapida da ust seviye kalacak (`led-setup`). Bu dogru karar cunku:
- Wizard 3 adimli, komplex bir akis
- Kendi header/step indicator/action bar'i var
- Diger bolumlere gomulmesi icin cok buyuk

### 3.4 Sistem Bolumu (su anki Settings > System)

#### 3.4.1 "Always On" Badge

**Mevcut sorun:** "Minimize to tray on close" toggle gibi gorunuyor ama aslinda degistirilemiyor ("Always on" badge). Bu gorsel olarak bir toggle row ama aslinda bilgi satiri.

**Oneriler:**
- Bu satiri tamamen kaldir. Tray davranisi tray-first uygulamada acik, ekstra bilgi gereksiz.
- Veya: "Launch at login" toggle'inin aciklamasina "The app always minimizes to tray when closed." ekle ve ayri satiri kaldir.

#### 3.4.2 Log Row Aksiyonsuz

**Mevcut sorun:** "Logs - Application logs are stored locally for debugging" diyor ama hicbir aksiyon sunmuyor.

**Oneriler:**
- "Open Log Folder" butonu ekle (Tauri `shell.open` ile log dizinini Finder'da ac)
- Veya satiri tamamen kaldir (kullanici log'a terminal'den ulaşır, cok niş)
- Minimum: dosya yolunu goster (monospace, kopyalanabilir)

#### 3.4.3 Guncelleme Konumu

**Mevcut sorun:** About & Logs bolumunun icinde gomulu. UpdateModal zaten otomatik cikiyor, bu satir sekonder.

**Oneriler:**
- System bolumunun en ustune tasi (dil secici ustune veya hemen altina)
- Veya sidebar'in alt kisminda (versiyon numarasinin yanina) kucuk bir "update available" badge goster

#### 3.4.4 Language Secici

**Mevcut sorun:** Kendi bolum basligi + aciklamasi + radio group. 2 dil icin cok fazla alan.

**Oneriler:**
- Baslik + aciklamayi tek satirda birlestir: sol taraf "Language", sag taraf dil butonlari
- Veya: "General" uygulama ayarlari kartinin icinde tek satir olarak goster

#### 3.4.5 Telemetri Entegrasyonu

Telemetri System bolumune tasindiktan sonra:
- Collapsible section olarak ekle (default kapali)
- Veya: sadece mod aktifken goster (Off moddayken telemetri anlamsiz)
- Polling interval'i 750ms'den 2000ms'e cikar (kullanici hizli degisimi zaten farketmez)

### 3.5 Telemetri (TelemetrySection)

#### 3.5.1 Bagimsiz Sekme Yeterliligi

**Karar:** Tek basina sekme icin yeterli icerik tasimiyor. 3 metrik kart + bos/hata state. System altinda collapsible section olarak daha dogru.

#### 3.5.2 Polling Agresifligi

**Mevcut sorun:** 750ms interval, component mount oldugu surece devam ediyor.

**Oneriler:**
- Interval'i 2000-3000ms'e cikar
- Visibility API kullan: sekme/pencere gorunur degilse polling'i durdur
- Mod OFF iken polling'i devre disi birak (captureFps ve sendFps zaten 0 olacak)

#### 3.5.3 Metrik Kart Hiyerarsisi

**Mevcut sorun:** 3 kart esit boyutta ama Queue Health metin bazli, FPS'ler sayisal.

**Oneriler:**
- Capture FPS ve Send FPS'yi yan yana (2 kolon), Queue Health'i altlarina tam genislikte koy
- Queue Health icin renk kodlamasi: healthy=yesil, warning=amber, critical=kirmizi (metin + dot)

---

## BOLUM 4: Cross-Cutting Sorunlar

### 4.1 Buton Stili Tutarsizligi

Uygulamada 3 farkli "primary" buton stili kullaniliyor:

1. **Slate/Zinc monokrom** (cogunlukta): `bg-slate-900 text-white dark:bg-zinc-100 dark:text-zinc-900` -- DeviceSection, CalibrationPage, ModeSelectorRow, OutputTargetsPanel
2. **Border + hover invert**: `border-slate-200 hover:border-slate-900 hover:bg-slate-900 hover:text-white` -- Refresh/Health Check butonlari
3. **Cyan accent** (nadir): `focus-visible:ring-cyan-400` -- focus ring'lerde var ama butonlarda yok

**Oneri:** Monokrom slate/zinc yaklasimininin korunmasi (cyan buton denenmis ve reddedilmis - bkz. memory). Ama 3 seviyeli buton hiyerarsisi tanimlanmali:
- **Primary**: `bg-slate-900 dark:bg-zinc-100` (mod degistir, kaydet, baglan)
- **Secondary**: `border-slate-200 dark:border-zinc-700` duz border, hover'da hafif bg (iptal, ikincil aksiyonlar)
- **Ghost**: `text-slate-500 hover:text-slate-700` border'siz, sadece metin (geri, kapat)

### 4.2 Focus Ring Eksikligi

**Mevcut durum:** Bazi butonlarda `focus-visible:ring-2 focus-visible:ring-cyan-400/60` var (ModeSelectorRow, OutputTargetsPanel), ama DeviceSection'daki butonlarin cogunda yok.

**Oneri:** Tum interaktif elementlere tutarli focus ring ekle. Global CSS'de:

```css
@layer components {
  .focus-ring {
    @apply focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/60 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-zinc-900;
  }
}
```

### 4.3 Dark Mode Surface Karisikligi

Uygulamada 3 farkli dark surface kullaniliyor:
- `dark:bg-zinc-950` -- ana arka plan (SettingsLayout)
- `dark:bg-zinc-900/80` -- kartlar (DeviceSection, GeneralSection)
- `dark:bg-zinc-800/40` -- ic kartlar (port grid, metrik kartlar)
- `dark:bg-zinc-800/30` -- connect bar, status card

Bu 4 seviye tutarli ama belgelenmemis. Tasarim dilinde elevation seviyeleri olarak belgelenmeli:
- **Level 0** (arka plan): `dark:bg-zinc-950`
- **Level 1** (ana kart): `dark:bg-zinc-900/80`
- **Level 2** (ic kart): `dark:bg-zinc-800/40`
- **Level 3** (ic ic kart): `dark:bg-zinc-800/30`

### 4.4 Ikon Tutarsizligi

- SettingsLayout'taki nav ikonlari ozel SVG (IconControl, IconCalibration, IconSettings)
- DeviceSection'daki ikonlar da ozel SVG ama farkli stil (strokeWidth farkli: 1.4 vs 1.6 vs 2.2)
- CalibrationPage'deki StepIndicator done durumunda literal `"✓"` kullanilyor (emoji, SVG degil)

**Oneri:**
- Tum ikonlar icin tutarli `strokeWidth="1.5"` standardi belirle
- `"✓"` yerine IconCheck SVG component'i kullan (DeviceSection'da zaten var)
- Ikon boyutu standardi: nav icin `h-4 w-4`, inline icin `h-3.5 w-3.5`, feature icin `h-5 w-5`

### 4.5 Scroll Davranisi

- SettingsLayout'ta `overflow-hidden` ana container'da var
- Her bolum kendi scroll'unu yonetiyor: `overflow-y-auto overscroll-contain`
- CalibrationPage'de content alani scroll'lu ama action bar sabit -- dogru
- DeviceSection icerigi uzun, Settings altindayken `min-h-0 flex-1 overflow-y-auto` ile sariliyor -- dogru ama scroll indicator gorunmuyor

**Oneri:** Scroll gereken alanlarda subtle scrollbar stili ekle (webkit-scrollbar veya Tailwind scrollbar plugin)

### 4.6 Animasyon/Transition Eksikligi

- Mod degisimi anlik (isModeTransitioning true olsa bile gorsel geri bildirim minimal)
- Tab gecisleri anlik (fade/slide yok)
- Accordion acilma/kapanma `grid-rows` transition'i sadece Hue wizard'da var, diger yerlerde yok

**Oneri:** `transition-all duration-150` veya `duration-200` ile:
- Tab icerik gecislerinde `opacity` transition
- Mod buton aktif durumunda `scale-95` active state (CalibrationPage butonlarinda var, GeneralSection'da yok)

---

## BOLUM 5: Oncelikli Uygulama Plani

### P0: Kullanici Akisini Kiran Seyler

```
[P0-1] Display adimi validasyonu
- Ne: CalibrationPage'de display secilmeden Continue'ya basilamamali
- Neden: Kullanici gecersiz durumda editor'e gecebiliyor
- Dosyalar: src/features/calibration/ui/CalibrationPage.tsx
- Bagimlilik: Yok
```

```
[P0-2] Tek monitor otomatik secim
- Ne: Display listesinde 1 eleman varsa otomatik sec
- Neden: Cogu kullanicida tek monitor var, gereksiz ekstra tik
- Dosyalar: src/features/calibration/ui/CalibrationPage.tsx
- Bagimlilik: P0-1
```

### P1: Kritik UX Sorunlari

```
[P1-1] Navigasyon yapisini yeniden duzenle (4 bolum)
- Ne: SECTION_IDS'i lights/led-setup/devices/system olarak guncelle,
      SettingsLayout sidebar'ini 4 bolume cikar,
      SettingsPage'i kaldir (artik gerekli degil),
      DeviceSection'i dogrudan ust seviye bolum olarak render et,
      SystemTab'i dogrudan ust seviye bolum olarak render et + TelemetrySection'i icine al
- Neden: Cihaz kurulumu ve kalibrasyon 2 tik gerektiriyor, sik kullanilan seyler gomulu
- Dosyalar:
    src/shared/contracts/shell.ts
    src/App.tsx
    src/features/settings/SettingsLayout.tsx
    src/features/settings/SettingsPage.tsx (silinecek veya refactor)
    src/locales/en/common.json
    src/locales/tr/common.json
- Bagimlilik: Yok (diger degisiklikler bunun uzerine insa edilir)
```

```
[P1-2] Section ID migration mapping
- Ne: loadShellState icindeki sectionMap'i yeni ID'lerle guncelle
- Neden: Mevcut kullanicilarin persisted state'i kirilmasin
- Dosyalar: src/App.tsx
- Bagimlilik: P1-1
```

```
[P1-3] i18n anahtarlarini guncelle
- Ne: settings.sections altindaki anahtarlari yeni bolum isimlerine guncelle
- Neden: Sidebar etiketleri degisecek
- Dosyalar: src/locales/en/common.json, src/locales/tr/common.json
- Bagimlilik: P1-1
```

```
[P1-4] Calibration wizard'a geri butonu ekle
- Ne: Display ve Editor adimlarinda action bar'a "<- Back" butonu ekle
- Neden: Step indicator tiklanabilir ama kesfedilebilirlik dusuk
- Dosyalar: src/features/calibration/ui/CalibrationPage.tsx
- Bagimlilik: Yok
```

```
[P1-5] Control ekraninda bos state yonetimi
- Ne: Hicbir cihaz bagli degilken + kalibrasyon yokken ozel bos state gorunumu
- Neden: Ilk acilista kullanici ne yapacagini bilmiyor
- Dosyalar: src/features/settings/sections/GeneralSection.tsx,
            src/features/settings/sections/control/CalibrationRequiredBanner.tsx
- Bagimlilik: P1-1 (yeni bolum isimleriyle uyumlu "Go to Devices" linki)
```

```
[P1-6] Output Targets Panelini zenginlestir
- Ne: Her cihaz chip'ine durum ozeti metni ekle, unavailable durumda yonlendirme
- Neden: Kullanici neden bir cihazin secilemedigini anlamiyor
- Dosyalar: src/features/settings/sections/control/OutputTargetsPanel.tsx
- Bagimlilik: P1-1
```

```
[P1-7] DeviceSection dikey alan optimizasyonu
- Ne: USB ve Hue bolumleri icin tab veya accordion yapisi,
      idle status card'i gizle,
      port listesini tek sutuna dusur
- Neden: 900x620 pencerede icerik tasiyor, scroll gerektiriyor
- Dosyalar: src/features/settings/sections/DeviceSection.tsx
- Bagimlilik: P1-1
```

```
[P1-8] Hue offline card'i compact yap
- Ne: Buyuk offline card yerine inline uyari + expandable detay
- Neden: Mevcut kart wizard'i gorsel olarak domine ediyor
- Dosyalar: src/features/settings/sections/DeviceSection.tsx
- Bagimlilik: P1-7
```

### P2: Gorsel Iyilestirmeler

```
[P2-1] Buton hiyerarsisini standartlastir
- Ne: Primary/Secondary/Ghost buton stillerini tanimla, tum bileşenlerde uygula
- Neden: 3 farkli primary buton stili var, tutarsiz
- Dosyalar: Tum bilesenler (DeviceSection, CalibrationPage, SettingsPage, GeneralSection)
- Bagimlilik: Yok
```

```
[P2-2] Focus ring tutarliligi
- Ne: Tum interaktif elementlere focus-visible ring ekle
- Neden: Bazi butonlarda var, bazılarinda yok
- Dosyalar: DeviceSection, CalibrationPage, SettingsPage
- Bagimlilik: Yok
```

```
[P2-3] Ikon stroke-width standartlastirma
- Ne: Tum SVG ikonlarda strokeWidth="1.5" standardi
- Neden: 1.4, 1.5, 1.6, 2.2 gibi farkli degerler kullaniliyor
- Dosyalar: SettingsLayout, DeviceSection, CalibrationPage
- Bagimlilik: Yok
```

```
[P2-4] Emoji checkmark'i SVG'ye degistir
- Ne: CalibrationPage StepIndicator'da "✓" yerine IconCheck SVG kullan
- Neden: Platformlar arasi tutarsiz render, tasarim dili ihlali
- Dosyalar: src/features/calibration/ui/CalibrationPage.tsx
- Bagimlilik: Yok
```

```
[P2-5] SolidColorPanel acilma animasyonu
- Ne: grid-rows transition ile smooth acilma/kapanma
- Neden: Ani gorunup kaybolma hissi var
- Dosyalar: src/features/settings/sections/GeneralSection.tsx
- Bagimlilik: Yok
```

```
[P2-6] Mod secici gorsel iyilestirme
- Ne: Off butonunu ayir, mod butonlarina ikon ekle, aktif mod icin subtle glow
- Neden: Off ile modlar ayni agirlikta, gorsel ayrım yok
- Dosyalar: src/features/settings/sections/control/ModeSelectorRow.tsx
- Bagimlilik: Yok
```

```
[P2-7] Dark mode elevation belgelendirme
- Ne: 4 seviyeli surface hiyerarsisini kodda yorum olarak ve README'de belgele
- Neden: Tutarli ama belgelenmemis, yeni bilesenler yanlis seviye kullanabilir
- Dosyalar: Kod yorumlari (SettingsLayout, DeviceSection)
- Bagimlilik: Yok
```

```
[P2-8] "Always on" satirini kaldir veya birlestir
- Ne: "Minimize to tray on close" satirini Launch at login aciklamasina tasi
- Neden: Degistirilemez ayar toggle gibi gorunuyor, alan israfi
- Dosyalar: src/features/settings/SettingsPage.tsx (veya yeni SystemSection)
- Bagimlilik: P1-1
```

```
[P2-9] Language seciciyi compact yap
- Ne: Baslik + aciklamayi tek satir, dil butonlarini yatay sira
- Neden: 2 dil icin cok fazla alan kaplaniyor
- Dosyalar: src/features/settings/SettingsPage.tsx (veya yeni SystemSection)
- Bagimlilik: P1-1
```

```
[P2-10] Log satirina "Open Folder" aksiyonu ekle
- Ne: Log dosya dizinini Finder'da acma butonu
- Neden: Mevcut satir bilgi veriyor ama aksiyonsuz
- Dosyalar: src/features/settings/SettingsPage.tsx (veya yeni SystemSection)
- Bagimlilik: Yok
```

### P3: Nice-to-Have

```
[P3-1] Telemetri polling optimizasyonu
- Ne: Interval'i 2000ms'e cikar, Visibility API ile pencere gorunur degilken durdur
- Neden: 750ms agresif, gereksiz CPU/network kullanimi
- Dosyalar: src/features/telemetry/ui/TelemetrySection.tsx
- Bagimlilik: Yok
```

```
[P3-2] Telemetri metrik kart hiyerarsisi
- Ne: FPS kartlarini yan yana, Queue Health'i altlarına, renk kodlamasi
- Neden: Esit boyutlu kartlar bilgi yogunlugunu yansitiyor
- Dosyalar: src/features/telemetry/ui/TelemetrySection.tsx
- Bagimlilik: Yok
```

```
[P3-3] Hue wizard "Ready" adimini kaldır veya dönüştür
- Ne: Ready adimini bağlantı testi adımına dönüştür veya kaldırıp header badge ile değiştir
- Neden: Mevcut icerik neredeyse bos
- Dosyalar: src/features/settings/sections/DeviceSection.tsx
- Bagimlilik: P1-7
```

```
[P3-4] Tab/bolum gecis animasyonlari
- Ne: opacity fade transition ile icerik gecisleri
- Neden: Anlik gecisler biraz kaba hissettiriyor
- Dosyalar: src/features/settings/SettingsLayout.tsx
- Bagimlilik: P1-1
```

```
[P3-5] Scrollbar stili
- Ne: Scroll gereken alanlarda subtle dark-mode uyumlu scrollbar
- Neden: Varsayılan scrollbar kalin ve parlak, dark mode ile uyumsuz
- Dosyalar: Global CSS (src/index.css veya tailwind config)
- Bagimlilik: Yok
```

```
[P3-6] Guncelleme kontrolunu one cikar
- Ne: System bolumunun en ustune veya sidebar versiyonun yanina "update badge"
- Neden: About & Logs icinde gomulu, kesfedilebilirlik dusuk
- Dosyalar: Yeni SystemSection + SettingsLayout
- Bagimlilik: P1-1
```

```
[P3-7] Hue wizard USB/Hue tab yapisi
- Ne: DeviceSection icinde USB ve Hue'yu alt tab ile ayir
- Neden: Iki icerik alani alt alta 900px pencerede scroll gerektiriyor
- Dosyalar: src/features/settings/sections/DeviceSection.tsx
- Bagimlilik: P1-7
```

---

## Onerilen Uygulama Sirasi

**Faz 1 (Temel Yapi):** P1-1 > P1-2 > P1-3
Navigasyon degisikligini once yap, gerisi bunun uzerine insa edilsin.

**Faz 2 (Kritik UX):** P0-1 + P0-2 > P1-4 > P1-5 > P1-6
Kalibrasyon validasyonu ve bos state.

**Faz 3 (Device Optimizasyonu):** P1-7 > P1-8
Device ekranini daralt.

**Faz 4 (Gorsel Tutarlilik):** P2-1 > P2-2 > P2-3 > P2-4
Buton/focus/ikon tutarliligi.

**Faz 5 (Detay Cilalamasi):** P2-5 thru P2-10 + P3-*
Animasyonlar, compact layout'lar, nice-to-have'ler.

---

## Notlar

- **Cyan accent karari**: Cyan buton denenmis ve reddedilmis. Primary butonlar monokrom slate/zinc kalmali. Cyan yalnizca focus ring ve streaming indicator icin kullanilmali.
- **Tray-first ilkesi**: Her birincil aksiyon 2 tiktan fazla olmamali (tray > pencere > sidebar item > aksiyon). Yeni yapiyla bu ilke karsilanacak.
- **i18n kurali**: Tum yeni stringler hem `en/common.json` hem `tr/common.json`'a eklenmeli.
- **Contract-first**: `shell.ts` degisiklikleri yapildiginda `yarn verify:shell-contracts` calistirilmali.
