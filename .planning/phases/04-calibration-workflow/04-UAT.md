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
updated: 2026-03-20T12:39:02Z
---

## Current Test

[testing complete]

## Tests

### 1. Ilk baglantida wizard auto-open ve save
expected: Uygulamayi cihaz bagli ve kalibrasyon kaydi yok durumda actiginda calibration wizard otomatik acilir; Save sonrasi overlay kapanir ve kayit olusur.
result: pass

### 2. Settings > Calibration > Duzenle yeniden giris
expected: Settings > Calibration bolumunden Duzenle tetiklenince ayni calibration editor overlay'i yeniden acilir.
result: issue
reported: "overlay açılmıyor görünüm tasarlanmamış. Test pattern toggle ON oluyor ama OS-level overlay görünmüyor; checkbox geri false oluyor / görünüm yok."
severity: major

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
result: issue
reported: "test patern açılmıyor overview yok"
severity: major

### 8. Overlay open fail blokaji ve reason
expected: Overlay open fail durumunda test pattern toggle bloke olur ve kullaniciya acik reason metni gosterilir.
result: issue
reported: "overlay görünmüyor bunu göremiyorum"
severity: major

### 9. Dirty-exit confirm davranisi
expected: Dirty degilken cikis onay modali gelmez; dirty durumda cikis denemesinde onay modali gelir.
result: issue
reported: "bunun hangi kısım olduğunu anlamadım"
severity: major

## Summary

total: 9
passed: 5
issues: 4
pending: 0
skipped: 0

## Gaps

- truth: "Settings > Calibration bolumunden Duzenle tetiklenince ayni calibration editor overlay'i yeniden acilir."
  status: failed
  reason: "User reported: overlay açılmıyor görünüm tasarlanmamış. Test pattern toggle ON oluyor ama OS-level overlay görünmüyor; checkbox geri false oluyor / görünüm yok."
  severity: major
  test: 2
  artifacts: []
  missing: []

- truth: "Test pattern acikken display hedefi degisince eski overlay kapanir, yeni hedefte tek aktif overlay acilir."
  status: failed
  reason: "User reported: test patern açılmıyor overview yok"
  severity: major
  test: 7
  artifacts: []
  missing: []

- truth: "Overlay open fail durumunda test pattern toggle bloke olur ve kullaniciya acik reason metni gosterilir."
  status: failed
  reason: "User reported: overlay görünmüyor bunu göremiyorum"
  severity: major
  test: 8
  artifacts: []
  missing: []

- truth: "Dirty degilken cikis onay modali gelmez; dirty durumda cikis denemesinde onay modali gelir."
  status: failed
  reason: "User reported: bunun hangi kısım olduğunu anlamadım"
  severity: major
  test: 9
  artifacts: []
  missing: []
