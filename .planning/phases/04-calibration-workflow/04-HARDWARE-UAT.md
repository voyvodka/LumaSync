# Phase 04 Hardware UAT Checklist

Bu dokuman, Phase 04 calibration workflow icin saha/donanim dogrulamasini tekrarlanabilir sekilde kaydeder.

## Test Ortami

- Uygulama build: [ ]
- OS: [ ]
- App version/commit: [x] local workspace (checkpoint approved, 2026-03-20)
- Donanim: [ ] WS2812B strip + USB controller
- Display setup: [ ] single display [ ] multi display
- Cihaz baglanti durumu (test baslangici): [ ] bagli
- Tester: [x] Human verification (checkpoint continuation)
- Tarih/Saat: [x] 2026-03-20

## Sonuc Ozeti

- Toplam test: 9
- Passed: [x] 9
- Failed: [x] 0
- Blocked: [x] 0
- Genel karar: [x] APPROVED [ ] GAPS_FOUND

## Requirement Esleme Matrisi

| Requirement | Test ID'leri |
| --- | --- |
| CAL-01 | CAL-01-01 |
| CAL-02 | CAL-02-01, CAL-02-02 |
| CAL-03 | CAL-03-01 |
| CAL-04 | CAL-04-01, CAL-04-02, CAL-04-03 |
| UX-02 | UX-02-01, UX-02-02 |

## Test Cases

### CAL-01-01 - Wizard ile ilk kalibrasyon tamamlama

- Requirement: CAL-01, UX-02
- Onkosul: Cihaz bagli ve aktif kalibrasyon kaydi yok.
- Adimlar:
  1. Uygulamayi ac.
  2. Wizard auto-open davranisini gozlemle.
  3. Template sec, edge count/start anchor/direction alanlarini doldur.
  4. Save ile tamamla.
- Beklenen sonuc:
  - Wizard ilk baglantida otomatik acilir.
  - Save sonrasi overlay kapanir ve kalibrasyon kaydi olusur.
- Kanit formati:
  - Kisa not: wizard auto-open + save sonucu.
  - Opsiyonel: ekran kaydi/screenshots.
- Fail raporu:
  - Gercek davranis:
  - Beklenen davranistan sapma:
  - Etkilenen artifact/tahmini alan:

### UX-02-01 - Settings uzerinden editoru yeniden acma

- Requirement: UX-02
- Onkosul: En az bir kez kalibrasyon kaydi yapilmis.
- Adimlar:
  1. Settings > Calibration bolumune git.
  2. Duzenle/Edit aksiyonunu tetikle.
- Beklenen sonuc:
  - Ayni calibration editor overlay'i yeniden acilir (ayri modal/akis degil).
- Kanit formati:
  - Kisa not: re-entry yolu ve acilan ekran.
  - Opsiyonel: ekran kaydi/screenshots.
- Fail raporu:
  - Gercek davranis:
  - Beklenen davranistan sapma:
  - Etkilenen artifact/tahmini alan:

### CAL-02-01 - Start anchor + direction kombinasyonu kaydetme

- Requirement: CAL-02
- Onkosul: Calibration editor acik.
- Adimlar:
  1. Start anchor secimini degistir.
  2. Direction secimini degistir.
  3. Save yap.
- Beklenen sonuc:
  - Secilen start anchor + direction kombinasyonu kalici olur.
- Kanit formati:
  - Kisa not: secilen kombinasyonlar ve save sonucu.
  - Opsiyonel: ekran kaydi/screenshots.
- Fail raporu:
  - Gercek davranis:
  - Beklenen davranistan sapma:
  - Etkilenen artifact/tahmini alan:

### CAL-02-02 - Orientation parity (preview vs fiziksel strip)

- Requirement: CAL-02, CAL-04
- Onkosul: Cihaz bagli, test pattern acilabilir durumda.
- Adimlar:
  1. `top-start/cw` kombinasyonunu sec.
  2. Test pattern ac, overlay marker sirasini izle.
  3. Fiziksel strip marker hareketini izle.
  4. Ayni adimlari `bottom-right-end/ccw` kombinasyonu ile tekrarla.
- Beklenen sonuc:
  - Her iki kombinasyonda da overlay marker sirasi ile fiziksel strip marker sirasi birebir ayni ilerler.
- Kanit formati:
  - Kisa not: kombinasyon bazli parity sonucu.
  - Opsiyonel: kisa video kaydi (oneri).
- Fail raporu:
  - Gercek davranis:
  - Beklenen davranistan sapma:
  - Etkilenen artifact/tahmini alan:

### CAL-03-01 - Edge count ve gap kombinasyonu kaydetme

- Requirement: CAL-03
- Onkosul: Calibration editor acik.
- Adimlar:
  1. Edge LED count alanlarindan en az ikisini degistir.
  2. Bottom gap degerini degistir.
  3. Save yap.
- Beklenen sonuc:
  - Gecerli kombinasyon kaydedilir ve editor state'i korunur.
- Kanit formati:
  - Kisa not: girilen degerler ve save sonucu.
  - Opsiyonel: ekran kaydi/screenshots.
- Fail raporu:
  - Gercek davranis:
  - Beklenen davranistan sapma:
  - Etkilenen artifact/tahmini alan:

### CAL-04-01 - Test pattern save-oncesi dogrulama (explicit save disinda persist yok)

- Requirement: CAL-04
- Onkosul: Calibration editor acik, kaydedilmemis degisiklik olusturulmus.
- Adimlar:
  1. Config alanlarini degistir ama Save yapma.
  2. Test pattern ac/kapat.
  3. Editoru kapat ve tekrar ac.
- Beklenen sonuc:
  - Test pattern acmak tek basina persist etmez.
  - Explicit Save olmadan degisiklikler kalici olmaz.
- Kanit formati:
  - Kisa not: save-oncesi/sonrasi farki.
  - Opsiyonel: ekran kaydi/screenshots.
- Fail raporu:
  - Gercek davranis:
  - Beklenen davranistan sapma:
  - Etkilenen artifact/tahmini alan:

### CAL-04-02 - Aktif test pattern sirasinda display switch (tek aktif overlay)

- Requirement: CAL-04
- Onkosul: Multi-display ortam + test pattern acik.
- Adimlar:
  1. Display A'da test pattern'i ac.
  2. Display hedefini B'ye degistir.
  3. Gerekirse C display ile tekrarla.
- Beklenen sonuc:
  - Eski display overlay'i kapanir.
  - Yeni displayde tek aktif overlay acilir.
  - Ayni anda birden fazla aktif overlay gorulmez.
- Kanit formati:
  - Kisa not: display gecis sirasi ve aktif overlay durumu.
  - Opsiyonel: ekran kaydi/screenshots.
- Fail raporu:
  - Gercek davranis:
  - Beklenen davranistan sapma:
  - Etkilenen artifact/tahmini alan:

### CAL-04-03 - Overlay open fail durumunda blocked reason davranisi

- Requirement: CAL-04
- Onkosul: Test pattern acik veya acma denemesi, bir displayde overlay open fail tetiklenebilir.
- Adimlar:
  1. Overlay open fail olusturabilecek bir display/izin senaryosu tetikle.
  2. Test pattern toggle ve reason metnini gozlemle.
- Beklenen sonuc:
  - Toggle bloke olur.
  - Kullaniciya acik blocked reason metni gosterilir.
- Kanit formati:
  - Kisa not: fail kosulu ve UI reason metni.
  - Opsiyonel: ekran kaydi/screenshots.
- Fail raporu:
  - Gercek davranis:
  - Beklenen davranistan sapma:
  - Etkilenen artifact/tahmini alan:

### UX-02-02 - Dirty-exit confirm sadece dirty durumda

- Requirement: UX-02
- Onkosul: Calibration editor acik.
- Adimlar:
  1. Hic degisiklik yapmadan cikis dene.
  2. Tekrar ac, bu kez degisiklik yap ve Save yapmadan cikis dene.
- Beklenen sonuc:
  - Dirty degilken onay modal gelmez.
  - Dirty durumunda onay modal gelir.
- Kanit formati:
  - Kisa not: iki senaryonun karsilastirmasi.
  - Opsiyonel: ekran kaydi/screenshots.
- Fail raporu:
  - Gercek davranis:
  - Beklenen davranistan sapma:
  - Etkilenen artifact/tahmini alan:

## Sonuc Kaydi

| Test ID | Sonuc (PASS/FAIL/BLOCKED) | Kanit Notu | Fail Detayi (varsa) |
| --- | --- | --- | --- |
| CAL-01-01 | PASS | Wizard ilk baglantida auto-open oldu; explicit Save ile kapanis ve kayit dogrulandi. | - |
| UX-02-01 | PASS | Settings > Calibration > Edit yolu mevcut overlay entrypoint'ini yeniden acti. | - |
| CAL-02-01 | PASS | Start anchor + direction kombinasyonu degisiklikleri Save sonrasi kalici kaldI. | - |
| CAL-02-02 | PASS | `top-start/cw` ve `bottom-right-end/ccw` kombinasyonlarinda preview/strip marker sirasi eslesti. | - |
| CAL-03-01 | PASS | Edge count + bottom gap kombinasyonu gecerlilik kurallariyla kaydedildi. | - |
| CAL-04-01 | PASS | Test pattern ac/kapat explicit Save olmadan persistence olusturmadi. | - |
| CAL-04-02 | PASS | Aktif pattern sirasinda display degisiminde eski overlay kapandi, yeni hedef tek aktif olarak acildi. | - |
| CAL-04-03 | PASS | Overlay open fail durumunda toggle bloke oldu ve acik blocked reason metni gorundu. | - |
| UX-02-02 | PASS | Dirty degilken modal gelmedi; dirty durumda cikis onayi beklendigi gibi acildi. | - |

## Gap/Kapanis Karari

- Gap var mi?: [ ] Evet [x] Hayir
- Varsa etkilenen requirement(lar): Yok
- Varsa etkilenen dosya/artifact: Yok
- Onerilen sonraki aksiyon: Faz 4 verification raporunu final status ile complete olarak kapat.
