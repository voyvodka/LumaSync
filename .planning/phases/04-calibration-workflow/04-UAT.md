---
status: complete
phase: 04-calibration-workflow
source:
  - 04-01-SUMMARY.md
  - 04-02-SUMMARY.md
  - 04-03-SUMMARY.md
  - 04-04-SUMMARY.md
  - 04-05-SUMMARY.md
  - 04-06-SUMMARY.md
  - 04-07-SUMMARY.md
  - 04-08-SUMMARY.md
  - 04-09-SUMMARY.md
  - 04-10-SUMMARY.md
  - 04-11-SUMMARY.md
  - 04-12-SUMMARY.md
started: 2026-03-20T12:28:42Z
updated: 2026-03-20T13:38:40Z
---

## Current Test

[testing complete]

## Tests

### 1. Ilk baglantida wizard auto-open ve save
expected: Uygulamayi cihaz bagli ve kalibrasyon kaydi yok durumda actiginda calibration wizard otomatik acilir; Save sonrasi overlay kapanir ve kayit olusur.
result: pass

### 2. Settings > Calibration > Duzenle yeniden giris
expected: Settings > Calibration bolumunden Duzenle tetiklenince ayni calibration editor overlay'i yeniden acilir.
result: pass
reported: "approved - overlay siyah, kalici ve monitore tam oturuyor."

### 3. Start anchor ve direction kaliciligi
expected: Start anchor ve direction degistirilip Save yapildiginda secimler kalici olur.
result: pass

### 4. Orientation parity (preview vs fiziksel strip)
expected: top-start/cw ve bottom-right-end/ccw kombinasyonlarinda overlay marker sirasi ile fiziksel strip marker sirasi birebir ayni ilerler.
result: pass

### 5. Edge count + bottom gap kaydetme
expected: Edge LED count ve bottom gap gecerli kombinasyonu Save ile kalici kaydedilir.
result: pass

### 6. Explicit save disinda persist olmamasi
expected: Save yapmadan test pattern ac/kapatmak degisiklikleri kalici hale getirmez; editor yeniden acildiginda eski kayit gorulur.
result: pass

### 7. Display switch sirasinda tek aktif overlay
expected: Test pattern acikken display hedefi degisince eski overlay kapanir, yeni hedefte tek aktif overlay acilir.
result: pass
reported: "approved - display switchte eski overlay kapaniyor ve yeni hedefte tek aktif overlay kaliyor."

### 8. Overlay open fail blokaji ve reason
expected: Overlay open fail durumunda test pattern toggle bloke olur ve kullaniciya acik reason metni gosterilir.
result: pass
reported: "approved - fail durumunda blocked akisi gozlenebilir ve normal akistan ayrisiyor."

### 9. Dirty-exit confirm davranisi
expected: Calibration Overlay acikken clean cikis denemesinde onay modali gelmez; dirty cikis denemesinde onay modali gelir.
result: pass
reported: "approved - clean cikista modal yok, dirty cikista onay modali geliyor."

#### Test 9 adimlari (ekran/buton seviyesi)

Clean mini senaryo (modal beklenmez):
1. Settings > Calibration > Duzenle ile Calibration Overlay'i ac.
2. Editor acildiktan sonra hicbir alan degistirme (count/start anchor/direction/bottom gap dokunma).
3. Ust sagdaki **Close** butonuna tikla (alternatif: alt bardaki **Cancel** butonu).
4. Beklenen: Overlay direkt kapanir, **Unsaved changes** modalı acilmaz.

Dirty mini senaryo (modal beklenir):
1. Settings > Calibration > Duzenle ile Calibration Overlay'i tekrar ac.
2. Editor'de herhangi bir alani degistir (ornek: Top count degerini +1/-1 yap veya direction degistir).
3. Ust sagdaki **Close** butonuna tikla (alternatif: alt bardaki **Cancel** butonu).
4. Beklenen: **Unsaved changes** onay modali gorunur; modalda **Keep Editing** ve **Discard** aksiyonlari cikar.
5. Opsiyonel dogrulama: **Keep Editing** editoru kapatmaz, **Discard** editoru kapatir.

## Summary

total: 9
passed: 9
issues: 0
pending: 0
skipped: 0

## Gaps

None - diagnosed Test 2/7/8/9 gapleri fixler sonrasi rerun'da kapandi ve kullanici sonucu `approved` olarak iletti.
