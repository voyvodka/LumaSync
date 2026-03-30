# Pitfalls Research

**Domain:** Desktop Ambilight + Room Visualization + Universal Light Management (LumaSync v1.2)
**Researched:** 2026-03-30
**Confidence:** MEDIUM-HIGH

> v1.0 ve v1.1 pitfall'lari korunmus, v1.2 icin yeni bolumler eklenmistir.
> v1.2-spesifik pitfall'lar **[v1.2]** etiketiyle isaretlenmistir.

---

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

**Warning signs:**
- 21:9/2.35:1 icerikte ust-alt LED'lerin aralikli flicker yapmasi.
- Ayni sahnede 5-15 saniyede bir border state degisimi.

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
- LED sayisina gore PSU secim hesabi ver.
- Wizard/diagnostics'te "power suspicion" sinyali uret (beyaz testte drop/flicker).

**Warning signs:**
- Tam beyaz testte sadece son bolumlerde renk bozulmasi.
- Uzun seanslarda artan kararsizlik.

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

**Warning signs:**
- Nadiren tekrar eden ama kaynagi belirsiz crashler.
- Port reconnect sirasinda UI'nin yanit vermemesi.

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
- Zorlayici testler ekle: USB unplug/replug, monitor sleep/wake, resolution change.

**Warning signs:**
- 20-40 dakika sonra frame drops artiyor.
- Sleep/wake sonrasi capture geri donmuyor.

**Phase to address:**
Phase 5 (Reliability + QA Gates)

---

### [v1.2] Pitfall 9: Hue CLIP v2 channel position write-back'te aktif stream kisitlamasini atlamamak

**What goes wrong:**
`PUT /clip/v2/resource/entertainment_configuration/{id}` ile kanal pozisyonlari guncellenmek istenir, ancak istek `active_streamer` durumunda bridge tarafindan reddedilir veya sessizce yoksayilir. Alternatif olarak, stream bittikten sonra yapilan write-back basarili gorunur ama bir sonraki GET'te degerler eski haline donmus olur.

**Why it happens:**
Hue Entertainment API tasarimi geregi: bir alan aktif olarak stream edilirken bridge konfigurasyonunu degistirmez. Calisan streaming oturumunun sahibi "channel assignments'i kilitler". Buna ek olarak, Hue CLIP v2 PUT body'sinde kanal pozisyonu icin `positions` anahtari `channels` dizisinin icerisindedir ve body formatini yanlis yazmak (ornegin `channel_id` yerine `channel_index` kullanmak) 4xx degil 200 doner ama efektsiz kalir.

**Mimarideki spesifik risk (LumaSync icin):**
Mevcut `hue_stream_lifecycle.rs`'de streaming aktifken `start_hue_stream` komutu `active_streamer` alanini kontrol ediyor. Ancak `put_entertainment_channel_positions` gibi yeni bir komut eklendiginde, streaming state'ini sorgulayan bir koruma katmani olmayabilir. Kullanici "Kaydet" butonuna basar, Rust tarafina istek gider, bridge 200 doner ama pozisyon degismez. Sessiz basarisizlik.

**How to avoid:**
- `put_hue_channel_positions` komutu baslamadan once `get_hue_stream_status` ile `HUE_STREAM_RUNNING` / `DTLS` durumu olup olmadigini kontrol et.
- Aktif stream varsa kullaniciya acik mesaj ver: "Pozisyonlari kaydetmek icin akisi durdurun" veya otomatik olarak durdur + kaydet + yeniden baslat akisi sun.
- Write-back'ten hemen sonra GET yaparak degerlerin duzgun yazilip yazilmadigini dogrula; sessiz basarisizligi tespit et.
- PUT body formatini resmi Hue CLIP v2 sema referansiyla dogrula: koordinatlar `channels[].position.{x,y,z}` altinda, degerler -1.0 ile +1.0 araliginda, `channel_id` (sifirdan baslamaz, Hue tarafindan atanan tam sayi) dogrulugu kritik.

**Warning signs:**
- "Kaydet" sonrasi UI "basarili" gosterir ama oda haritasi yeniden acilinca eski pozisyonlar var.
- Bridge 200 donduruyor ama body bos `{}` veya `errors: []`.
- Hue uygulamasinda kanal pozisyonlari degismemis.

**Phase to address:**
v1.2 - Hue Channel Position Write-back Fazinin ilk haftalari; API kontratin ve sessiz hata durumlarinin test edilmesi zorunlu.

---

### [v1.2] Pitfall 10: Hue koordinat sistemi ile canvas koordinat sistemi arasindaki flip'i atlamak

**What goes wrong:**
Hue CLIP v2 pozisyon koordinati y-ekseni: `-1 = alt (floor), +1 = ust (ceiling/top-of-room)` seklindedir. Ancak HTML5 Canvas/CSS y-ekseni: `0 = ust, artar = asagi` seklindedir. Bu flip yapilmadan oda haritasina aktarilan noktalar dikey olarak ters gorunur. Kullanici ust duvardaki ampulu asagiya surukler, bridge tarafina "y = -0.8" yazilir, Hue uygulamasinda ampul yukarda gorunur.

**Why it happens:**
Mevcut `HueChannelMapPanel.tsx`'deki `posToPercent` fonksiyonu bu flip'i dogru yapiyor (`top = ((1 - cy) / 2) * 100`). Ancak yeni room map editor eklendikten sonra drag sonucu hesaplanan pozisyon canvas'tan Hue koordinatina donusturulurken bu flip unutulursa, write-back yanlis deger gonder.

**Mimarideki spesifik risk (LumaSync icin):**
Mevcut kod read-only gosterim icin dogru ceviriyi yapuyor. Ancak "surukleme -> yeni pozisyon hesapla -> bridge'e yaz" akisi eklendiginde, DOM/canvas'tan gelen offsetX/offsetY pixellerini normalize edilmis Hue koordinatina donustrme adimi eksik veya hatali olabilir.

**How to avoid:**
- Koordinat donusum fonksiyonlarini merkezi bir utility'e tasi: `canvasPercentToHue(leftPct, topPct)` ve `hueToCanvasPercent(x, y)` karsilikli tutarli olmali.
- Donusum fonksiyonlari icin birim testleri yaz: `hueToCanvasPercent(-1, -1)` -> `{left: 0%, top: 100%}`, `hueToCanvasPercent(1, 1)` -> `{left: 100%, top: 0%}`.
- Write-back oncesinde z koordinatini da ele al: Hue 3D koordinat kullanir (x, y, z), oda haritasi 2D ise z sabit bir varsayimla (ornegin z=0) doldurulabilir ama bu deger eksik birakılirsa bridge 4xx atabilir.

**Warning signs:**
- Haritada ust duvardaki kanal suruklendikten sonra Hue uygulamasinda asagi duvarda gorunuyor.
- Kanal noktalari kaydetme oncesinde dogru konumda, sonrasinda yanlislanmis.

**Phase to address:**
v1.2 - Room Map Editor gelistirme baslangici; donusum utility yazilmadan canvas drag koduna girilmemeli.

---

### [v1.2] Pitfall 11: LED zone'larini oda haritasindan tureterken koordinat uzayi uyumsuzlugu

**What goes wrong:**
Oda haritasindaki "sol duvar" kanal konumu `x ~ -1.0` demektir. LED LED `left` segment'inin ekran sol kenarini kapladigi anlamina gelir. Ancak mevcut `LedCalibrationConfig` modeli segment sayilari ve `startAnchor` ile calisir; dunya koordinati degil, saydim bazli bir modeldir. Bu iki modeli otomatik olarak eslestirmeye calismak "duvar pozisyonu = ekran kenari hissiyati" varsayimini sorgusuz kabul etmek demektir; kullanicinin LED seridi ekranin cok uzerinde veya cok asagisinda olmasi durumunda yanlis zone atamasi uretilir.

**Why it happens:**
Oda haritasi 3D mekan koordinatlari kullanir; ekran bazli LED kalibrasyon modeli ise monitor kenarlari etrafinda normallestirmis segment sayilari kullanir. Bu iki uzay arasinda dogrudan matematiksel bir esitlik yoktur; kullanicinin fiziksel kurulumuna baglidir.

**How to avoid:**
- Otomatik turetim bir "onerim" olarak sun, otomatik uygulama olarak degil. Kullanicinin "auto-derive" sonucunu inceleyip onaylamasi zorunlu olmali.
- Turetim karar agacini acik tanimla: `x < -threshold` -> `left`, `x > threshold` -> `right`, `y > threshold` -> `top`, `y < -threshold` -> `bottom`, aksi halde `center`. Threshold degeri kullaniciya acik veya konfigure edilebilir olmali.
- LED segment sayisini degistirmeden zone atamasi guncelleme modelini ayri tut: "hangi segmentin hangi Hue kanalini temsil ettigi" ile "LED sayisi" bagimsiz olmali.
- Ilk iterasyonda: oda haritasi LED zone onerisini gosteriyor, kullanici onayli; ikinci iterasyonda otomatik guncelleme.

**Warning signs:**
- LED sol segment yanlit, ama oda haritasindaki sol kanal dogru konumda gosteriliyor.
- Kullanici "oda haritasini degistirdim, LED renkleri ters cevrildi" raporu.
- Oda haritasi save/load dongusunde LED kalibrasyon profili kaybolmus veya sifirlinis.

**Phase to address:**
v1.2 - LED Zone Auto-Derivation Fazi; turetim mantigi oda haritasi verisi stabilize olmadan yazilmamali.

---

### [v1.2] Pitfall 12: Hue standalone modunda USB-first state machine'in kilitlemeleri

**What goes wrong:**
Mevcut uygulama USB-first olarak tasarlanmis: birden fazla akis "lighting mode" state machine'i USB baglantisini kontrol eder, `ledCalibration` eksikse uyarilari tetikler, `lastOutputTargets` kontrolunde USB girdisi beklenir. Hue standalone modunda USB hicbir zaman baglanmayacak; ancak bu kontroller "cihaz yok" durumunu "hata" olarak isaretlemeye devam edebilir. Kullanici Hue'yu baslatmak ister, UI "Kalibrasyon gerekli" veya "Cihaz baglanmadi" banner'i gosterir.

**Mimarideki spesifik risk (LumaSync icin):**
`CalibrationRequiredBanner.tsx` ve `ModeSelectorRow.tsx` mevcut USB-calibration state'ini kontrol ediyor. `lastOutputTargets` sadece `["hue"]` icerdiginde USB ile ilgili guard'larin devreye girmemesi gerekiyor. Bu mantik yoksa standalone Hue modu basarisiz gorunur.

**How to avoid:**
- `lastOutputTargets` degeri single source of truth olmali. `["hue"]` icerdiginde USB state kontrollerini gec/es.
- `CalibrationRequiredBanner` ve benzeri USB-gated UI elemanlari icin `isUsbTargetActive()` gibi bir yardimci yazin; her yerde ayri `ledCalibration` kontrolu yapmayin.
- "Standalone Hue" ilk launch senaryosu icin yeni bir state path tanimla: USB hicbir zaman baglanmadi + Hue bagli = normal durum, hata degil.
- `ShellState.ledCalibration` absent oldugunda sadece USB hedefli modlari kapsamali; Hue hedefli modlari etkilememeli.

**Warning signs:**
- USB baglanmadan Hue'yu baslattiginda "Kalibrasyon gerekli" banner cikiyor.
- Mode selector Hue modunu disable gosteriyor, USB baglanmadigi icin.
- `get_runtime_telemetry` cagrisi USB hatasini Hue ozeti olarak yanlik propagate ediyor.

**Phase to address:**
v1.2 - Hue Standalone Mode Fazi; USB guard'larin hedef-aware hale getirilmesi ilk adim olmali.

---

### [v1.2] Pitfall 13: Canvas kütüphanesi seciminde Tauri WebView2'nin GPU acceleration sorununu goz ardi etmek

**What goes wrong:**
React Konva veya fabric.js gibi canvas tabanli kutuphaneler, Windows'ta Tauri WebView2 icinde GPU hardware acceleration olmadan yuksek CPU kullanimiyla calisir. Oda haritasinda 10-20 suruklenebilir nokta varken bile frame drop ve UI takilmasi gorulur. Ozellikle WebView2'nin GPU blocklist'i bazi grafik kart/surucu kombinasyonlarini devre disi birakir.

**Why it happens:**
Tauri GitHub Issue #4891'de belgelenmistir: WebView2, GPU blocklist nedeniyle canvas ve CSS filtreler icin GPU acceleration devreye almaz. Chrome/Firefox'ta sorunsuz calisan kodu Tauri'de test etmeden deploy etmek bu farki ortaya cikarmaz.

**Spesifik LumaSync riski:**
Mevcut ayarlar sayfasi gecerli bir canvas kullanimiyor; ancak oda haritasi editoru eklendiginde, WebView2 ortaminda test yapilmadan canvas kutuphanesi secilirse performans sorunlari cikabilir.

**How to avoid:**
- Tauri `main.rs`'de WebView2 GPU blocklist'i bypass et: `std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "--ignore-gpu-blocklist")` - bu bilinen workaround (Issue #4891, COMPLETED olarak kapanmis).
- Canvas kutuphanesi olarak React Konva'yi sec (dragdrop + scene graph + React entegrasyonu + iyi performance tips dokumantasyonu); PixiJS gerekli degil (oyun grafigi), fabric.js daha agir ve React-friendly degil.
- Konva layer stratejisini dogru kur: "static" arka plan (duvarlar, odaci) ayri layer, "interactive" noktalar (kanal/LED noktalari) ayri layer; max 3-4 layer.
- `listening={false}` ile etkilesim gerektirmeyen shape'leri hit graph'tan cikar.
- Oda haritasi icin 10-30 nokta bekleniyor; bu sayida Konva hicbir problemsiz calisir. 100+ nokta durumunda `FastLayer` veya cache devreye girer.

**Warning signs:**
- Bir noktayi suruklarken diger nesneler "titriyor" veya gecikmeyle render ediliyor.
- GPU Gorevi Yoneticisinde 0% iken CPU Canvas isinligi yuksek.
- Yalnizca Windows/WebView2'de yavas, tarayicida hizli.

**Phase to address:**
v1.2 - Room Map Canvas Infra secimi; kutupane secilmeden once WebView2'de `--ignore-gpu-blocklist` prototip testi yapilmali.

---

### [v1.2] Pitfall 14: Oda haritasi verisinin hem Hue pozisyonunu hem LED kalibrasyonu surdurmesi — "tek kaynak" yanilsamasi

**What goes wrong:**
Oda haritasi editoru eklendikce iki farkli consumer ortaya cikar: (1) Hue bridge'e yazilacak kanal pozisyonlari, (2) LED ambilight zone atamasi. Her iki taraf da "oda haritasi verisi = source of truth" diye bagli tutulursa, birinin degisimi digeri icin beklenmedik sonuclar dogurur. Ornegin kullanici Hue kanalini hafifce kaydirdiginda LED zone atamalari da otomatik yeniden hesaplanir; kullanici istemeden ambilight profilini bozar.

**Why it happens:**
Temiz mimari fikri ("tek kaynak") bazen anlamsal olarak farkli iki modeli birbirine baglar. Hue kanal pozisyonu, Hue bridge'in fiziksel koordinatidir; LED zone atamasi ise ekran kenarina gore semantik bir atama.

**How to avoid:**
- `RoomMapState` -> derive -> `HueChannelPositions` (Hue write-back icin) ve -> `LedZoneHints` (LED atamasi icin) seklinde iki turetilmis model tanimla; ama `LedZoneHints` otomatik uygulanmamali, kullanici onayina tabi olmali.
- `ledCalibration` (mevcut `ShellState` alani) Hue oda haritasindan bagimsiz yonetilmeli; dogrudan iliskilendirilmemeli.
- Her iki turetimde de "son onaylanan deger" persiste edilmeli; ham oda haritasi verisinden her seferinde yeniden hesaplama yapilmamali.
- Bagimliligi acikca belge: oda haritasi degistigi zaman hangi downstream veri otomatik guncellenir, hangisi kullanici onayina muhtactir.

**Warning signs:**
- Kullanici Hue kanalini hareket ettirdi, LED renkleri ters cevrildi veya baska bir kenara gecti.
- Oda haritasini kaydedip uygulamadan cikince LED ambilight profili "kayip" oldu.
- `hueChannelRegionOverrides` ile `ledCalibration` arasinda tutarsizlik.

**Phase to address:**
v1.2 - Veri modeli tasarimi; oda haritasi verisinin hangi alanlari persist edilecek, hangilerinin downstream etkileri neler, bunlar kontrat olarak tanimlanmadan gelistirmeye girilmemeli.

---

### [v1.2] Pitfall 15: 2D'de "yetersiz" hissettiren arayuz—3D'ye gecis tuzagi

**What goes wrong:**
Oda haritasi editoru "flat" 2D gorunumle baslatilir. Ekip "gercekci gorunmuyor" hissettigi icin three.js veya benzer bir 3D katman ekler. Bu: (1) gelistirme suresini 3-5x arttirir, (2) Tauri WebView2 ortaminda WebGL performans riskleri dogurur, (3) kullanicinin asil ihtiyaci olan "kanalim kabaca nerede" problemini cozmuyor, genellikle daha karmasik hale getiriyor.

**Why it happens:**
Gorselli mockup'lar 3D'de daha etkileyici gorunur. Hue uygulamasinin kendi editoru 3D benzetmesi kullanir. Referans noktasi yanlis secilir.

**Gercek referans:**
Mevcut `HueChannelMapPanel.tsx` zaten 16:10 aspect-ratio bir "oda gorunumu" ve kanal noktalari ile cok iyi is yapan bir 2D panel. Bu pattern, 15-20 kanali olan bir entertainment area icin yeterlidir. Sorun 2D'nin "yetersiz" olmasi degil, drag-drop yoklugu.

**How to avoid:**
- Drag-drop'lu 2D React Konva editor ile basla. TV gorunumu zaten var (`HueChannelMapPanel`), kanal noktalari suruklenmeli.
- 3D gecis karari bir "evet/hayir" olarak v1.2 scope'undan cikar; backlog'a "gelecek milestone" olarak koy.
- "Oda haritasi 3D olmali" istegiyle karsilasilirsa: kullanicilarin asil hedefini sorgula (kanal konumunu hizlica atamak), 3D'nin bu hedefe ne kadar katki saglayacagini degerlendir.

**Warning signs:**
- Three.js veya A-Frame gibi bagimliliklarin eklenmeye baslanmasi.
- Room map sprint'in scope'unda 3D modelleme veya perspective projection gereksinimleri gorulmesi.
- "Birakin kullanicilari kamera ile oda taratsin" gibi istekler.

**Phase to address:**
v1.2 - Room Map tasarim fazinin basinda; scope tanimlanmadan once 2D-first karar kayit altina alinmali.

---

## Technical Debt Patterns

Shortcuts that seem reasonable but create long-term problems.

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Tum frame'i CPU'da islemek | Hizli prototip | Yuksek latency ve fan/CPU sikayeti | Sadece ilk spike prototipte, max 1-2 gun |
| Tek "magic" smoothing ayari | Basit UI | Farkli icerikte ya flicker ya gecikme | MVP'de 2 preset ile gecici |
| Port hatalarinda sadece auto-restart | Hizli kurtarma hissi | Sonsuz reconnect loop, debug zorlasir | Asla tek basina degil |
| Layout'u sadece drag-drop offset olarak saklamak | Kod kisa | Profil tasinabilirligi ve tekrar kalibrasyon sorunu | Asla; semantik model gerekir |
| [v1.2] Oda haritasi pozisyonunu raw canvas pixel olarak persist etmek | Hizli | Canvas boyutu degisince pozisyonlar kayar | Asla; normalize edilmis Hue koordinatini persist et |
| [v1.2] Hue write-back'i "fire and forget" yapmak | Daha az kod | Sessiz basarisizlik; kullanici veriyi kaybetti zanneder | Asla; dogrulama GET zorunlu |
| [v1.2] USB guard'lari Hue standalone icin gecikmeli kaldirmak | Hizli shipping | Standalone modda UX broken; kullanicilar butonu bulamaz | Sadece alfa asamasinda kisa sure |

## Integration Gotchas

Common mistakes when connecting to external services/devices.

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| Windows capture API | Rotation/HDR/device-lost path'lerini atlamak | Capture abstraction'inda bu durumlari first-class state yap |
| USB Serial (COM) | Write timeout/backpressure yok | Bounded queue + timeout + reconnect state machine uygula |
| WS2812B strips | Tek noktadan guc verip uzun hatta devam etmek | Coklu guc enjeksiyonu + ortak GND + cap/resistor standardi koy |
| [v1.2] Hue CLIP v2 channel position PUT | Stream aktifken write deneyip sessiz hata almak | Stream status kontrol et, aktifse durdur veya kullaniciya bildir |
| [v1.2] Hue CLIP v2 coordinate system | y-flip yapmadan canvas koordinatini direkt bridge'e gondermek | Merkezi `canvasToHue` ve `hueToCanvas` donusum utility; birim testli |
| [v1.2] React Konva + WebView2 Windows | GPU blocklist nedeniyle yuksek CPU; canvas'ta jank | `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--ignore-gpu-blocklist` main.rs'e ekle |

## Performance Traps

Patterns that work at small scale but fail as usage grows.

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| LED zonelarini fazla ince tutmak | Serial doluluk ve jitter | Zone sayisini ekran boyutu yerine algisal faydaya gore sinirla | 150+ LED ve 30+ FPS hedeflerinde belirgin |
| Her frame'i gondermek (frame coalescing yok) | Queue birikimi, gecikme artisi | En yeni frame stratejisi + delta/threshold gonderim | Hareketli sahnelerde dakikalar icinde |
| Smoothing'i output'ta degil capture'da uygulamak | Renk dogrulugu bozulur | Sampling->color pipeline sonrasinda temporal smoothing uygula | Karanlik-gecisli sahnelerde hemen |
| [v1.2] Konva'da tum shape'leri tek layer'a koymak | Dragging sirasinda tum scene yeniden render | Interactive (draggable) noktalari ayri layer'a al | 20+ shape, frequent drag |
| [v1.2] Her drag event'inde Hue bridge'e PUT atmak | Bridge throttling; 429 hatasi | Drag end'de tek write; onizleme local state'te | Ilk suru-birak siklusunda |

## Security Mistakes

Domain-specific security issues beyond general web security.

| Mistake | Risk | Prevention |
|---------|------|------------|
| Firmware/profil importunu dogrulamadan calistirmak | Kotu niyetli payload ile cihaz/uygulama kararsizligi | Signed/validated profile schema, strict parser, safe defaults |
| Yerel API/IPC'yi sinirsiz acmak | Lokal kotuye kullanim, isik kontrolunun ele gecmesi | Localhost-scope, explicit auth token, command allowlist |
| Loglara ham ekran/cihaz bilgisi yigmak | Gizlilik ihlali (icerik metadata) | Redaction + opt-in diagnostic paketleri |
| [v1.2] Hue appKey/clientKey'i oda haritasi ile birlikte export etmek | Bridge kimlik bilgileri disari sizabilir | Profil export'unda kimlik bilgileri strip edilmeli; ayri guvenli depolama |

## UX Pitfalls

Common user experience mistakes in this domain.

| Pitfall | User Impact | Better Approach |
|---------|-------------|-----------------|
| Wizard'da teknik jargon ile baslamak | Kurulum yarida birakilir | Once sonuc odakli adimlar, advanced ayar sonradan |
| Canli preview olmadan layout kalibrasyonu | Deneme-yanilma ve hayal kirikligi | Her adimda edge highlight ve test pattern onizleme |
| "Connected" ama gercekte stream yok durumu | Kullanici neyin bozuk oldugunu anlayamaz | Cihaz durumu: Connected / Streaming / Degraded / Reconnecting ayrimi |
| [v1.2] Oda haritasindaki kanal noktalari cok kucuk veya birbirine cok yakin | Surukleme yanlis kanal yakaliyor | Minimum 20px hedef alani; snap-to-grid veya minimum distance kontrol |
| [v1.2] Hue write-back "Kaydet" butonu olmadan otomatik yapilmak | Kazara yapilan surukleme bridge'i degistiriyor | Explicit "Save to Bridge" onay adimi; local draft vs. committed state ayrimi |
| [v1.2] Standalone Hue moduna giris yolunun belirsiz olmasi | Kullanici USB zorunlu zanneder | USB olmadan da "Hue Only" modunu ilk ekranda net goster; setup flow'da ayri dal |

## "Looks Done But Isn't" Checklist

Things that appear complete but are missing critical pieces.

- [ ] **Realtime Ambilight:** Sadece "goruntu geliyor" degil; 60 dakika soak + unplug/replug geciyor mu?
- [ ] **Calibration:** Sadece kaydetme degil; monitor rotation degisince profil tutarli mi?
- [ ] **Serial Transport:** Sadece yazma degil; timeout/backpressure metrikleri var mi?
- [ ] **Color Quality:** Sadece SDR dogru degil; HDR acik sistemde de kabul edilebilir mi?
- [ ] **Recovery:** Sadece restart degil; app kendisi recover edip stream'e donebiliyor mu?
- [ ] **[v1.2] Room Map Drag:** Surukle-birak pozisyon dogru mu? Canvas'tan Hue koordinatina donusum birim testli mi?
- [ ] **[v1.2] Hue Write-back:** "Kaydet" sonrasi GET ile dogrulama yapildi mi? Aktif stream varken denemede acik hata mi cikiyor?
- [ ] **[v1.2] Standalone Hue:** USB hic baglanmadan: kalibrasyon banner cikmadi, mode selector blocked degil, Hue normal baslatildi.
- [ ] **[v1.2] LED Zone Derivation:** Oda haritasi degistirince LED segmentleri otomatik degil, kullanici onayla degisiyor mu?
- [ ] **[v1.2] WebView2 GPU:** `--ignore-gpu-blocklist` flag mevcut mu? Canvas drag 60fps'e yakin mi Windows'ta?

## Recovery Strategies

When pitfalls occur despite prevention, how to recover.

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| Capture pipeline overload | MEDIUM | FPS/zoning'i runtime'da dusur, perf-profile kaydet, kullaniciya "balanced mode" oner |
| Serial saturation/disconnect loop | MEDIUM | Queue drain et, port state reset, baud/payload preset downgrade uygula |
| Power/voltage instability | HIGH | Test pattern ile fault isolate et, guc enjeksiyon ve PSU rehberiyle yeniden kurulum yaptir |
| Mapping mismatch | LOW-MEDIUM | Profil rollback + hizli edge-by-edge recalibration wizard'i calistir |
| [v1.2] Hue write-back sessiz basarisizligi | LOW | Write-back sonrasi GET ile dogrulama ekle; "pozisyon kaydedilemedi" hatasi goster; streaming stop/write/start akisi sun |
| [v1.2] Canvas koordinat flip hatasi | MEDIUM | Merkezi donusum utility ile tum drag handler'lari guncelle; persisted harita verisini migrate et |
| [v1.2] Standalone Hue - USB guard kilitlemeleri | MEDIUM | Target-aware guard'lari ekle; `lastOutputTargets` kontrol noktalari `isUsbTargetActive()` ile sarmalanir |

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
| [v1.2] Hue write-back stream lock (P9) | v1.2 Hue Channel Write Fazi | Aktif stream sirasinda kayit -> acik hata; stream sonrasi -> GET dogrulamasiyla basarili |
| [v1.2] Koordinat y-flip hatasi (P10) | v1.2 Room Map Infra | Donusum birim testleri pass; surukleme + kaydet + reopen uyumu |
| [v1.2] LED zone derivation uyumsuzlugu (P11) | v1.2 Zone Derivation Fazi | Onay gereken durumlarda auto-apply olmuyor; kullanici onayi zorunlu |
| [v1.2] USB guard Hue standalone kilitleme (P12) | v1.2 Standalone Mode Fazi | USB baglanmadan tam Hue akisi hatasiz calisuyor |
| [v1.2] WebView2 GPU acceleration (P13) | v1.2 Canvas Infra hazirlanirken | `--ignore-gpu-blocklist` flag aktif; Windows'ta canvas drag akici |
| [v1.2] Dual-consumer veri model uyumsuzlugu (P14) | v1.2 Veri Modeli Tasarimi | Hue pozisyon degisimi LED profilini otomatik degistirmiyor |
| [v1.2] 3D scope creep (P15) | v1.2 Design Review | Three.js/3D bagimlilik yok; 2D-first kararsi roadmap'te kayitli |

## Sources

**v1.0 / v1.1 kaynaklari:**
- Microsoft Desktop Duplication API: https://learn.microsoft.com/en-us/windows/win32/direct3ddxgi/desktop-dup-api (HIGH)
- Microsoft Windows Graphics Capture: https://learn.microsoft.com/en-us/windows/uwp/audio-video-camera/screen-capture (HIGH)
- .NET SerialPort DataReceived semantics: https://learn.microsoft.com/en-us/dotnet/api/system.io.ports.serialport.datareceived (HIGH)
- Adafruit NeoPixel Uberguide: https://learn.adafruit.com/adafruit-neopixel-uberguide/best-practices (MEDIUM-HIGH)
- Hyperion issue history: https://github.com/hyperion-project/hyperion.ng/issues/1030 (MEDIUM)

**v1.2 yeni kaynaklari:**
- Hue CLIP v2 entertainment_configuration API model (aiohue): https://github.com/home-assistant-libs/aiohue/blob/main/aiohue/v2/models/entertainment_configuration.py (MEDIUM - koordinat araligini teyit ediyor, PUT schema icin resmi Hue dev portal gerekli)
- HyperHDR Hue CLIP v2 discussion (kanal koordinat ornekleri): https://github.com/awawa-dev/HyperHDR/discussions/512 (MEDIUM)
- Tauri WebView2 GPU blocklist issue (workaround dogrulanmis): https://github.com/tauri-apps/tauri/issues/4891 (HIGH - COMPLETED)
- React Konva performance tips: https://konvajs.org/docs/performance/All_Performance_Tips.html (HIGH)
- React Konva drag & drop: https://konvajs.org/docs/react/Drag_And_Drop.html (HIGH)
- OpenHue API (Hue CLIP v2 OpenAPI spec): https://github.com/openhue/openhue-api (MEDIUM - PUT body schema dogrulamasi icin)
- Fabric.js vs Konva vs PixiJS 2026 karsilastirma: https://www.pkgpulse.com/blog/fabricjs-vs-konva-vs-pixijs-canvas-2d-graphics-libraries-2026 (MEDIUM)

---
*Pitfalls research for: Desktop Ambilight + Room Visualization + Universal Light Management (LumaSync v1.2)*
*Researched: 2026-03-30*
