---
status: diagnosed
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
updated: 2026-03-20T13:03:10Z
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
reported: "OVERLAY_OPEN_FAILED: OVERLAY_WINDOW_OPEN_FAILED: a webview with label `calibration-overlay-7df1ecb19df184ee` already exists. Overview ekranı açılmadı."
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
reported: "Display switch denemesinde overlay tekrar acilamadi; ayni label already exists hatasiyla toggle blocked kaldi."
severity: major

### 8. Overlay open fail blokaji ve reason
expected: Overlay open fail durumunda test pattern toggle bloke olur ve kullaniciya acik reason metni gosterilir.
result: issue
reported: "[LumaSync] Test pattern blocked (OVERLAY_OPEN_FAILED): OVERLAY_WINDOW_OPEN_FAILED: a webview with label `calibration-overlay-7df1ecb19df184ee` already exists."
severity: major

### 9. Dirty-exit confirm davranisi
expected: Calibration Overlay acikken clean cikis denemesinde onay modali gelmez; dirty cikis denemesinde onay modali gelir.
result: issue
reported: "bunun hangi kısım olduğunu anlamadım"
severity: major

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
passed: 5
issues: 4
pending: 0
skipped: 0

## Gaps

- truth: "Settings > Calibration bolumunden Duzenle tetiklenince ayni calibration editor overlay'i yeniden acilir."
  status: failed
  reason: "User reported: OVERLAY_OPEN_FAILED: OVERLAY_WINDOW_OPEN_FAILED: a webview with label `calibration-overlay-7df1ecb19df184ee` already exists. Overview ekranı açılmadı."
  severity: major
  test: 2
  root_cause: "Overlay kapanisinda backend pencereyi `close()` ile kapatiyordu; app-level close-to-tray intercept `CloseRequested` eventini yakaladigi icin overlay destroy olmadan gizli kaliyor. Sonraki open denemesinde ayni label zaten var hatasi olusuyor."
  artifacts:
    - path: "src-tauri/src/commands/calibration.rs"
      issue: "close_overlay_window `close()` kullandigi icin overlay event interception altinda tamamen yok olmuyor"
    - path: "src-tauri/src/lib.rs"
      issue: "global on_window_event close intercepti overlay window close requestlerini de etkiliyor"
  missing:
    - "Overlay pencere kapanisinda `CloseRequested` interception'a takilmayan force-destroy davranisi"
    - "Fix sonrasi Duzenle/Test Pattern ON rerun ile tek overlay acilisinin dogrulanmasi"
  debug_session: ".planning/debug/calibration-edit-overlay-not-opening.md"

- truth: "Test pattern acikken display hedefi degisince eski overlay kapanir, yeni hedefte tek aktif overlay acilir."
  status: failed
  reason: "User reported: display switchte overlay tekrar acma denemesi already exists hatasina dustu"
  severity: major
  test: 7
  root_cause: "Eski overlay window'u close intercept nedeniyle runtime'da yasadigi icin close-old/open-new zincirinde yeni hedef ayni label ile acilamiyor."
  artifacts:
    - path: "src-tauri/src/commands/calibration.rs"
      issue: "close step force destroy yapmadigi icin tek aktif zincir stale window ile kiriliyor"
    - path: "src/features/calibration/state/displayTargetState.ts"
      issue: "state dogru sekilde blocked snapshot'a geciyor ancak backend stale window sebebiyle open basarisiz"
  missing:
    - "stale overlay window temizleme fixi"
    - "fix sonrasi display switch close-old/open-new UAT rerun kaydi"
  debug_session: ".planning/debug/test-pattern-overlay-missing-on-display-switch.md"

- truth: "Overlay open fail durumunda test pattern toggle bloke olur ve kullaniciya acik reason metni gosterilir."
  status: failed
  reason: "User reported: blocked reason metni goruldu fakat sebep stale label collision oldu"
  severity: major
  test: 8
  root_cause: "Fail akisinin kendisi dogru gorunuyor; fail sebebi overlay close pathinde stale webview birakilmasi (label already exists)."
  artifacts:
    - path: "src-tauri/src/commands/calibration.rs"
      issue: "window close pathi stale label collision uretiyor"
    - path: "src/features/calibration/ui/CalibrationOverlay.tsx"
      issue: "blockedReason metni hata kodunu dogru yansitiyor; backend fixi sonrasi tekrar UAT gerekiyor"
  missing:
    - "backend stale label root-cause fixi"
    - "fix sonrasi blocked reason yalnizca gercek fail durumlarinda gorundugunun UAT kaydi"
  debug_session: ".planning/debug/overlay-open-fail-blocked-reason-not-visible.md"

- truth: "Dirty degilken cikis onay modali gelmez; dirty durumda cikis denemesinde onay modali gelir."
  status: failed
  reason: "User reported: bunun hangi kısım olduğunu anlamadım"
  severity: major
  test: 9
  root_cause: "Kod davranisi dogru; sorun UAT adiminin kullanici acisindan belirsiz yazilmasi nedeniyle testin nerede yapilacaginin anlasilmamasi."
  artifacts:
    - path: "src/features/calibration/state/calibrationEditorState.ts"
      issue: "dirty/clean cikis karari deterministik ve testlerle korunuyor"
    - path: ".planning/phases/04-calibration-workflow/04-UAT.md"
      issue: "Test 9 aciklama adimlari ekran-buton seviyesinde yeterince net degil"
  missing:
    - "UAT Test 9 metninde close/cancel adimlarinin ekran bazli netlestirilmesi"
    - "dirty ornegi icin adim adim mini senaryo eklenmesi"
  debug_session: ".planning/debug/dirty-exit-confirm-path-unclear.md"
