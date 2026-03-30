# Feature Research

**Domain:** Smart home room visualization + universal light management (Ambilight desktop)
**Researched:** 2026-03-30
**Milestone:** v1.2 — Oda Gorselleştirme ve Evrensel Isik Yonetimi
**Confidence:** MEDIUM (Hue CLIP v2 API details verified via aiohue model + Q42.HueApi; room map UX patterns via web search + SmartThings/Home Assistant community; some coordinate range details LOW confidence due to gated Hue developer portal)

---

## Scope Note

Bu dosya v1.2 milestone'una ozgudur. v1.0 feature landscape'i (USB LED, kalibrasyon, temel modlar)
`.planning/milestones/v1.0-ROADMAP.md` altinda arsivlenmistir. Asagidaki tum tablolar yalnizca yeni
ozellikleri ve v1.1'den tasinan tamamlanmamis birimleri kapsar.

---

## Feature Landscape

### Feature Grubu 1: 2D Oda Haritasi ve Isik Kaynagi Konumlandirma

#### Table Stakes (Kullanicilarin Beklentisi)

| Feature | Neden Beklenir | Karmasiklik | Notlar |
|---------|----------------|-------------|--------|
| Surukle-birak isik kaynagi konumlandirma | SmartThings Map View (2024), Home Assistant Floorplan, Govee DreamView hepsi sezgisel konumlandirma uzerinden calisiyor | MEDIUM | Izgara veya serbest koordinat destegi; isaret piksel koordinati, asil fiziksel ol cekleme degil |
| TV / monitoru referans nesne olarak haritaya yerlestirme | Isik pozisyonlarinin manali olmasi icin ekran konumunun bilinmesi gerekiyor — Hyperion ve Hue Sync her ikisi de oturma noktasi + ekran referansi kullaniyor | MEDIUM | Basit dikdortgen, boyut degistirilebilir, yon secilmeli (ekranin onune bakan yuzu) |
| Haritadaki isik kaynaginin anlik gercek cihaza baglanmasi | Kullanici konumlandirirken hangi lambaci/sekerin aktive oldugunu bilmeli — Hue uygulamasi konumlandirma sirasinda cihazi yanip sondurur | LOW | "Identify" ping'i: Hue icin DTLS solid renk flash, USB LED icin kisa test deseni |
| Konumun kaydedilmesi ve session'lar arasi yeniden yuklenmesi | Kullanici her acilista haritayi yeniden olusturursa hicbir deger yoktur | LOW | plugin-store'a persist et; key olarak alan ID veya profil ID kullan |
| Birden fazla isik kaynagi turunu ayni haritada gosterme | Hue + USB LED serit birlikte kullanildiginda kullanici birlesik gorsel istiyor | MEDIUM | USB LED = ekranin etrafinda cerceve simgesi; Hue kanali = noktasal veya bolge simgesi |

#### Differentiators (Rekabet Avantaji)

| Feature | Deger Onerisi | Karmasiklik | Notlar |
|---------|---------------|-------------|--------|
| Harita pozisyonundan otomatik Ambilight LED bolge atamasina gecis | Oda haritasi + ekran referansi + LED serit konumu birlesince kullanicinin manuel kalibrasyon yapmasini ortadan kaldirir; Hyperion ve HyperHDR bunu hala tamamen manueldir | HIGH | Geometri: LED seridi ekranin neresinde (sol/sag/ust/alt), uzaklik ve aci zaten haritadan cikiyor |
| Hue kanal xyz → ekran bolge on izlemesi | Hue Entertainment area kanal pozisyonlari CLIP v2 API ile okunabilir; uygulama hangisinin sol, sag vs oldugunu tahmin edip kullaniciya onaylatabilir | MEDIUM | Ayrinti asagida: "Hue Kanal Pozisyon Editorü" bolumunde |
| USB + Hue birlesik oda gosterimi (tek canvas) | Hue Sync yalnizca Hue gorur; Hyperion yalnizca LED gosterir; LumaSync her ikisini tek haritada gosteriyor | HIGH | LED serit, ekranin arkasinda bir cerceve olarak, Hue noktalari ise odada serbest olarak |

#### Anti-Features (Kacınilacaklar)

| Feature | Neden Istenir | Neden Sorunlu | Alternatif |
|---------|---------------|---------------|------------|
| Gercekci 3D oda modeli (duvarlar, mobilyalar) | "Eksiksiz" gorunuyor | Kullanicinin duvar olcumlerini girmesi gerekiyor, bu ciddi giris surtusmesi; smart home topluluklari (CEPRO, HA forum) bu kompleksligin kullanicilari uzaklastirdigini consistently raporluyor | Basit 2D top-down canvas, sadece oda sinirlari opsiyonel ve cizilabilir |
| Otomatik oda olcumu / lidar taramasi | Kullanisli gorunuyor | Masaustu uygulamasinda fizibil degil, kamera/sensor gerektiriyor | Manuel surukle-birak; olcek zorunlu degil |
| Tum ekranlar icin coklu oda yukleme wizard'i v1.2'de | Guclu gorunuyor | Multi-monitor / multi-controller kendi complexity'si var; v1.2 scope cikisina neden olur | v1.2: tek ekran + tek oda haritasi; multi odali yapi v2'ye ertelenmeli |
| Fiziksel mesafe gosterimi (metre/feet cinsinden) | Hassas gorunuyor | Duzgunlestirmek icin tum parcalarda olcek tutarliligini zorlar; ambilight icin kritik degil | Ekrana gore goreceli koordinatlar yeterlidir (sol / sag / uzak / yakin) |
| Oda haritasini PNG/SVG olarak disari aktar | Power-user talebi | Kompleks render pipeline, v1.2 icin deger/maliyet orani dusuk | Sonraki milestone'a ertelemek uygundur |

---

### Feature Grubu 2: Hue Entertainment Area Kanal Pozisyon Editoru

#### Hue CLIP v2 Kanal Pozisyon Sistemi (Arastirma Bulgulari)

Hue CLIP v2 `entertainment_configuration` kaynaginda her kanal icin 3D xyz koordinati vardir:
- **x**: yatay eksen, -1 (sol) ile +1 (sag) arasi (tahmini; resmi portal gizli)
- **y**: dikey eksen, genellikle sabit = 1 (TV yuksekligi) ekran kurulumlarinda
- **z**: derinlik ekseni, -1 (arkaplanda, izleyiciye uzak) ile +1 (on plan, izleyiciye yakin)
- `positions: list[Position]` — gradient seritler icin birden fazla konum destekleniyor
- Koordinatlar odanin merkezine (seyirci konumu) gore goreceli

Q42.HueApi, uzamsal filtreleme icin `GetLeft()`, `GetRight()`, `GetCenter()` yardimci metodlari sunuyor (kaynak: michielpost/Q42.HueApi EntertainmentApi.md — HIGH confidence).

Koordinatlari bridge'e geri yazmak icin PUT `/clip/v2/resource/entertainment_configuration/{id}` kullaniliyor; `service_locations` alani guncelleniyor (kaynak: aiohue modeli, HA kütüphanesi — MEDIUM confidence).

**Onemli kisit:** Hue Sync ve Hue mobil uygulama kanal pozisyonlarini kendi surukle-birak arayuzleriyle kaydeder. Ucuncu taraf uygulamalar koordinatlari okuyabilir ve yazabilir, ancak Hue uygulamasinin yaptigi gibi kanallar manuel tasindiktan sonra bridge'i "yetkili kaynak" kabul etmek gerekir.

#### Table Stakes

| Feature | Neden Beklenir | Karmasiklik | Notlar |
|---------|----------------|-------------|--------|
| CLIP v2 API'den mevcut kanal pozisyonlarini okuma | Kullanici zaten Hue uygulamasinda konumlanma yapmis olabilir; bunun uzerine insaat yapmak mantiklidir | MEDIUM | GET `entertainment_configuration`, parse et, kanallar icin xyz yukle |
| Kanal basina ekran bolge etiketi (sol/sag/ust/alt/merkez) | Hyperion bunu hmin/hmax, vmin/vmax degerleriyle hallediyor (0.0-1.0 arasi), Hue xyz koordinatlarindan ayni bilgi turedilebilir | LOW | xyz → bolge donusumu basit: x < -0.2 = sol, x > 0.2 = sag, z < -0.2 = ust vb. |
| Kullanicinin kanal pozisyonunu surukleme veya bolge secimi ile duzeltmesi | Kanallar otomatik taninan pozisyondan farkli fiziksel yerdeyse kullanici duzeltmek ister | MEDIUM | 2D top-down harita uzerinde surukle veya dropdown (sol/sag/ust/alt/merkez) |
| Degisiklikleri bridge'e geri yazma secenegi (opsiyonel kayit) | Kullanici Hue ekosistemiyle senkronde kalmak istiyorsa; diger uygulamalar da bu konumdan yararlanir | MEDIUM | "Save to bridge" explicit buton ile; silent auto-save degil — Hue uygulamasiyla catismayi onler |

#### Differentiators

| Feature | Deger Onerisi | Karmasiklik | Notlar |
|---------|---------------|-------------|--------|
| Xyz koordinatlarindan otomatik bolge tahmini + kullanici onay akisi | Kullanici konumlari tek tek elle atamak yerine "Looks right?" onay adimi goruyor | MEDIUM | Hyperion veya Hue Sync'te yok; friction azaltir |
| Kanal pozisyonunu bridge'e yazmadan yalnizca uygulama icinde override | Kullanici Hue uygulamasini bozmak istemeyebilir; sadece LumaSync icin farkli bir ekran bolge haritasi isteyebilir | LOW | `hueChannelRegionOverrides` zaten shell.ts'de mevcut — bu feature icin altyapi hazir |

#### Anti-Features

| Feature | Neden Istenir | Neden Sorunlu | Alternatif |
|---------|---------------|---------------|------------|
| Per-channel renk kalibrasyonu / gain ayari | Guclü gorunuyor | DTLS streaming zaten kanal-basina renk gonderiyor; gain kalibrasyonu renk motoru katmaninda yapilmali, pozisyon editorunde degil | Ayri renk kalibrasyonu sayfasinda ertelenmeli |
| Kanal pozisyon editoru icinde tam LED layout editoru | Her seyi tek yerde toplamak istenebilir | LED layout editoru mevcut, kod tabaninda ayri oturuyor; birlestirme, her iki editoru bozabilir | Kanal pozisyon editoru Hue'ya ozgu kalsin; LED layout editoru suanda oldugu yerde |

---

### Feature Grubu 3: LED Zone Otomatik Turetimi (Oda Haritasindan)

#### Table Stakes

| Feature | Neden Beklenir | Karmasiklik | Notlar |
|---------|----------------|-------------|--------|
| LED serit konumundan ekran kenari → LED segment egitimi | Hyperion bunu hala elle yapiyor (hmin/hmax/vmin/vmax); haritadan otomatik turetme deger katlar | HIGH | Algoritma: LED serit ekranin hangi kenarinda (ust/alt/sol/sag), mesafe ve aci bilinince piksel bolge atamasi turkime |
| Otomatik turetilen atamayi kullanicinin gorecegi onay adimi | Siyah kutu algoritma emniyetsiz; kullanici sonucu gorup duzeltebilmeli | MEDIUM | Mevcut LED layout editorunde "preview" modu ile entegre |
| Sadece oda haritasindaki konuma dayali basit atama (cihaz bagimli degil) | Kullanici USB LED veya Hue ikisini de kullandiginda atama mekanizmasinin farkli olmamasi gerekiyor | MEDIUM | Tek koordinat kaynagi: oda haritasi; cikis: her iki hedef icin bolge etiketi |

#### Differentiators

| Feature | Deger Onerisi | Karmasiklik | Notlar |
|---------|---------------|-------------|--------|
| LED segment sayisina gore kapi agirligini otomatik olarak normalize etme | Birden fazla monitor veya farkli boyutlarda LED seritler oldugunda renk katkilari orantisiz olamasin | HIGH | v1.2 kapsami disinda tutmak uygundur; tek ekran icin gerekli degil |

#### Anti-Features

| Feature | Neden Istenir | Neden Sorunlu | Alternatif |
|---------|---------------|---------------|------------|
| Fully automatic zone derivation without any user confirmation step | Kullanicinin hic yapacagi bir sey olmamasi cekici | Kotu sonuclar sessizce production'a gidiyor; kullanici ilk bakista yanlisligi farketmeyebilir | Otomatik tahmin + acik onay adimi; kullanici elle duzeltme haklarini saklasin |

---

### Feature Grubu 4: Hue Standalone Modu (USB Seritsiz)

#### Table Stakes

| Feature | Neden Beklenir | Karmasiklik | Notlar |
|---------|----------------|-------------|--------|
| USB cihaz olmadan uygulamanin baslatilabilmesi | Kullanicinin yalnizca Hue altyapisi varsa uygulamanin USB beklememesi gerekiyor | LOW | USB detection "required" yerine "optional" hale getirilmeli |
| Mod secicinin USB serit olmadan Ambilight + Hue modunu sunmasi | Hue Sync desktop uygulamasi tam olarak bu: Hue lambalarini ekrana senkronize et, USB serit yok | LOW | `lastOutputTargets` zaten shell.ts'de `["hue"]` destekliyor |
| Hue-only kurulumda device panel'inin USB hata gostermemesi | USB disconnect hatasi, sadece Hue kullanan kullaniciya anlamli degil | LOW | USB durum gostergesini `lastOutputTargets` degerine gore kosullu gizle |
| Kalibrasyon wizard'inin Hue-only mode'da atlanilebilmesi | Kalibrasyonun gerekliligi USB LED seridine ozgu; Hue icin LED segment sayisi yok | MEDIUM | Wizard flow'unda "I only use Hue" bypass yolu |

#### Differentiators

| Feature | Deger Onerisi | Karmasiklik | Notlar |
|---------|---------------|-------------|--------|
| Hue-only modu ile USB modu arasinda tek settings toggle | iConnectHue ve Hue Sync yalnizca Hue goriyor; LumaSync hem/hem modunu destekliyor | MEDIUM | Settings'te "Output target" veya "Active devices" secimi — HUX-02 ile ortusuyor |
| Hue standalone'da Ambilight efektinin kalite sinyali | Hue Update rate min 50ms (20Hz); kullaniciya latency beklentisini acikca goster | LOW | Telemetri panelinde Hue-specific FPS ve latency |

#### Anti-Features

| Feature | Neden Istenir | Neden Sorunlu | Alternatif |
|---------|---------------|---------------|------------|
| Hue-only modu icin ayri bir "lite" uygulama olusturma | Temiz UX | Kod tabanini boler, ozellik gerilimine yol acar | Tek uygulama, konfigurasyona gore gorunurlugu kosullu yonet |
| USB tamamen kaldirildiginda Hue'ya otomatik failover | Kullanisli gorunuyor | USB cekilmesi ile USB-only kullanim modeli catisiyor; sessiz failover beklenti yaniltir | Acik output target secimi; otomatik gecis yalnizca kullanici bunu acikca aktive etmissse |

---

### Feature Grubu 5: v1.1'den Tasinan Gelistirmeler

#### HUE-08 — Fault Recovery

| Feature | Neden Beklenir | Karmasiklik | Notlar |
|---------|----------------|-------------|--------|
| Gecici DTLS stream hatasindan sonra manuel restart gerektirmeden otomatik yeniden baglanti | Hue DTLS baglantisi zaman zaman duser (uyku modu, ag gecikmesi); kullanici her seferinde uygulamayi yeniden baslatmak zorunda kalmamali | HIGH | Retry state machine zaten RECONNECTING state'ini destekliyor (contracts.ts'de); eksik olan Rust tarafinda kalici retry loop |

#### HUX-01 — Device UX

| Feature | Neden Beklenir | Karmasiklik | Notlar |
|---------|----------------|-------------|--------|
| Hue baglanti ve stream durumunun Device settings yuzeyinden yonetilebilmesi | Kullanici USB ve Hue'yu ayni yerden izlemeli; mode panel'inde gorulen baglanti durumu settings'e de yansiyin | MEDIUM | DeviceSection + HueChannelMapPanel refactor edilerek Hue stream health row eklenmeli |

#### HUX-02 — Target Switching

| Feature | Neden Beklenir | Karmasiklik | Notlar |
|---------|----------------|-------------|--------|
| USB ve Hue arasinda cikis hedefini kalibrasyon ve mod config kaybetmeden degistirebilme | Kullanici her ikisine de sahipse geceyi Hue, sabahi USB ile gecirmek isteyebilir | MEDIUM | `lastOutputTargets` zaten persisted; eksik olan: switching sirasinda mevcut mod state'inin korunmasi |

#### HDR-01 / HDR-02 — Diagnostics

| Feature | Neden Beklenir | Karmasiklik | Notlar |
|---------|----------------|-------------|--------|
| Hue hata kodlarinin kodlanmis aciklamalar ve kurtarma ipuclariyla gosterilmesi (HDR-01) | Kullanicinin "HUE_STREAM_FAILED" gibi bir kod gorup ne yapacagini bilememesi sinir bozucu | LOW | Hue status kodu → kullanici dostu mesaj + action hint mapping tablosu |
| Hue stream sagligi sinyallerinin runtime izlenebilmesi (HDR-02) | Sorun giderme icin; telemetri paneli zaten USB icin bu ozelligi sagliyor | LOW | Telemetri paneline Hue hedefi icin latency, yeniden baglanti sayaci, son hata eklenmeli |

---

## Feature Dependencies

```
Oda Haritasi (2D)
    └──gerektirir──> TV/Monitoru referans nesne olarak yerlestirebilme
    └──gerektirir──> Isik kaynaklarinin haritada persist edilmesi

LED Zone Otomatik Turetimi
    └──gerektirir──> Oda Haritasi (2D) — serit konumu + ekran konumu gerekli
    └──gerektirir──> Mevcut LED kalibrasyon modeli (LedCalibrationConfig)
    └──enhances──> Mevcut kalibrasyon wizard'i (onay adimi olarak entegre)

Hue Kanal Pozisyon Editoru
    └──gerektirir──> CLIP v2 API erisimi (halihazirda mevcut: list_hue_entertainment_areas, get_hue_area_channels)
    └──enhances──> Oda Haritasi (2D) — kanal konumlari haritaya ulasturiliyor

Hue Standalone Modu
    └──gerektirir──> lastOutputTargets ["hue"] — zaten shell.ts'de mevcut
    └──gerektirir──> USB'nin optional hale getirilmesi (initialization akisi degisikligi)
    └──enhances──> HUX-02 Target Switching — birlikte tek bir "output target" mekanizmasi olusturuyorlar

HUX-02 Target Switching
    └──enhances──> Hue Standalone Modu

HUE-08 Fault Recovery
    └──gerektirir──> Mevcut Hue runtime state machine (Reconnecting state zaten tanimli)
    └──onkoşul──> HDR-01/02 Diagnostics — kullanici hata kaydini gormeden recovery onemi anlasilamaz

HDR-01/02 Diagnostics
    └──enhances──> HUE-08 Fault Recovery

Oda Haritasi
    └──conflicts──> 3D oda modeli (kapsam disinda, over-engineering riski)
```

### Dependency Notes

- **LED Zone otomatik turetimi, Oda Haritasini gerektirir:** Serit konumu bilinmeden hangi kenara kacin LEDs atanacagi hesaplanamaz.
- **Hue Kanal Editoru, Oda Haritasini enhances eder:** Editoru haritadan bagimsiz yaptirsak bile ortak koordinat canvas'i tutarlilik saglar.
- **Hue Standalone, USB initialization akisini degistirir:** Bu, USB detection flow'una dokunan tek v1.2 ozelligi; diger ozellikler tamamen yeni alanlara eklemedir.
- **HUE-08 retry loop, mevcut contract'larla uyumlu:** `RECONNECTING` state ve `remainingAttempts` zaten tanimli; eksik Rust tarafindaki surekli retry worker'dir.

---

## MVP Definition

### v1.2 Launch With (Bu milestone icin gereken minimum)

- [ ] 2D oda haritasi: TV + LED serit + Hue kanallarini surukle-birak yerlestirebilme
- [ ] Oda haritasi persisted (session'lar arasi hayatta kaliyor)
- [ ] Hue kanal pozisyonlarini CLIP v2'den okuma ve ekran bolge etiketi gosterme
- [ ] USB olmadan uygulama baslatilabilmesi (Hue standalone akisi)
- [ ] HUE-08: Gecici DTLS hatalarindan otomatik kurtarma
- [ ] HUX-01: Hue durumu Device settings yuzeyinde gorунur
- [ ] HUX-02: Cikis hedefi USB / Hue / ikisi birden olarak secilebilir
- [ ] HDR-01: Hue hata kodlari aciklamali mesajlar ve action hint ile gosterilir
- [ ] HDR-02: Hue stream sagligi telemetri panelinde gorülebilir

### Add After Core Validation (v1.2.x)

- [ ] LED zone otomatik turetimi — harita verisine dayali, kullanici onay adimli
- [ ] Hue kanal pozisyonlarini bridge'e geri yazma (opsiyonel kayit)
- [ ] Oda haritasindan Hue kanal xyz pozisyonu tahmini + onay akisi

### Future Consideration (v2+)

- [ ] Coklu oda haritasi / coklu monitor duzenlemesi
- [ ] Oda haritasi PNG/SVG disari aktarimi
- [ ] Fiziksel oda boyutlari ile hassas olcek destegi
- [ ] USB-only veya Hue-only modundan USB+Hue karma akisina otomatik gecis

---

## Feature Prioritization Matrix

| Feature | Kullanici Degeri | Uygulama Maliyeti | Oncelik |
|---------|-----------------|-------------------|---------|
| HUE-08 Fault Recovery | HIGH | HIGH | P1 |
| HUX-02 Target Switching + Standalone | HIGH | MEDIUM | P1 |
| HDR-01 Error messages + action hints | HIGH | LOW | P1 |
| HUX-01 Device surface Hue status | MEDIUM | LOW | P1 |
| 2D oda haritasi (temel canvas + TV + LED + Hue) | HIGH | HIGH | P1 |
| Hue kanal pozisyon okuma + bolge etiketleme | MEDIUM | MEDIUM | P1 |
| HDR-02 Hue telemetry panel | MEDIUM | LOW | P2 |
| LED zone otomatik turetimi (haritadan) | HIGH | HIGH | P2 |
| Hue kanal pozisyonunu bridge'e geri yazma | LOW | MEDIUM | P2 |
| Coklu oda / monitor destegi | MEDIUM | HIGH | P3 |

**Priority key:**
- P1: v1.2 launch icin zorunlu
- P2: v1.2.x'te eklenebilir, onaylandiktan sonra
- P3: v2+ icin ertelenecek

---

## Competitor Feature Analysis

| Feature | Hyperion / HyperHDR | Philips Hue Sync Desktop | Govee DreamView Desktop | LumaSync Hedefi |
|---------|---------------------|--------------------------|-------------------------|-----------------|
| Oda haritasi | Yok; yalnizca LED layout editor (hmin/hmax/vmin/vmax) | Hue uygulamasina devrediliyor | Hayir; yalnizca ekran bolge template'i | 2D top-down canvas, LED + Hue birlikte |
| Hue kanal pozisyon duzenleme | HyperHDR LED Hardware tab'inda surukle-birak (sadece HyperHDR tarafli; bridge'e yazilmiyor) | Hue mobil app araciligiyla | Desteklenmiyor | Hem uygulama-icinde override hem bridge'e yazma secenegi |
| LED zone otomatik turetimi | Manuel; wizard yok | Uygulanamaz (LED yok) | Uygulanamaz | Haritadan geometrik turetim + onay adimi |
| Hue standalone modu | Evet, Hue destekliyor; USB LED ile birlikte de kullanilabilir | Yalnizca Hue (USB LED yok) | Yalnizca Govee | Tek uygulamada USB / Hue / ikisi birden |
| Fault recovery (DTLS) | Temel yeniden baglanti var | Opak; kullanici yeniden baslatmak zorunda | Kapsam disinda | Acik state machine, kullaniciya gorunur retry metrikleri |

---

## Sources

- aiohue v2 entertainment_configuration model (HA kütüphanesi, resmi kaynak): https://github.com/home-assistant-libs/aiohue/blob/main/aiohue/v2/models/entertainment_configuration.py — HIGH confidence
- Q42.HueApi EntertainmentApi.md — GetLeft/GetRight spatial methods, xyz koordinat sistemi: https://github.com/michielpost/Q42.HueApi/blob/master/EntertainmentApi.md — MEDIUM confidence
- HyperHDR Hue CLIP v2 tartisma (kanal xyz ornekleri, gradient serit kurulumu): https://github.com/awawa-dev/HyperHDR/discussions/512 — MEDIUM confidence
- HyperHDR LED hardware editor (hmin/hmax/vmin/vmax, 0.0-1.0 range): https://www.hyperhdr.eu/2021/04/how-to-set-up-hyperhdr-part-i-basic.html — MEDIUM confidence
- Samsung SmartThings Map View (CES 2024 duyurusu, drag-drop 2D light positioning): https://news.samsung.com/us/smartthings-revolutionizes-home-visualization-with-introduction-of-map-view/ — MEDIUM confidence
- Philips AmbiScape (oda genisletme, 4 dis lamba koordinasyonu, 2026 lansmanı): https://hueblog.com/2026/03/18/ambiscape-all-the-details-on-the-successor-of-ambilighthue/ — MEDIUM confidence
- Govee DreamView desktop app (zone division, screen region mapping): https://desktop.govee.com/user-manual/user-guide — MEDIUM confidence
- Hue Entertainment area 3D isometric setup (2.5D yukseklik + konum):  https://hueblog.com/2021/05/06/philips-hue-4-0-improves-placement-of-lamps-in-the-entertainment-area/ — LOW (page rendered as JS only; bilgi HyperHDR tartismasi ile dogrulanmistir)
- Hyperion LED position configuration (hmin/hmax bolge sistemi): https://docs.hyperion-project.org/user/advanced/Advanced.html — MEDIUM confidence
- CEPRO: floor plan UI user fatigue analysis: https://www.cepro.com/news/do-map-view-user-interfaces-simplify-smart-home-management/137819/ — LOW confidence (industry press, not primary source)

---
*Feature research for: v1.2 Room Visualization + Universal Light Management (LumaSync)*
*Researched: 2026-03-30*
