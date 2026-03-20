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
updated: 2026-03-20T12:59:08Z
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
  reason: "User reported: overlay açılmıyor görünüm tasarlanmamış. Test pattern toggle ON oluyor ama OS-level overlay görünmüyor; checkbox geri false oluyor / görünüm yok."
  severity: major
  test: 2
  root_cause: "Backend open_display_overlay komutu gercek OS-level overlay olusturmuyor; sadece state guncelleyip success donuyor, bu nedenle UI aciliyor gibi olsa da gorunur overlay yok."
  artifacts:
    - path: "src-tauri/src/commands/calibration.rs"
      issue: "open_display_overlay state-only, render/window olusturma yok"
    - path: "src/features/calibration/ui/CalibrationOverlay.tsx"
      issue: "overlay open fail durumunda toggle geri false ve blocked state'e donuyor"
  missing:
    - "open_display_overlay/close_display_overlay icin gercek overlay lifecycle implementasyonu"
    - "OS-level overlay basarisizliginda sebep kodu ve UI mesaj zincirinin netlestirilmesi"
  debug_session: ".planning/debug/calibration-edit-overlay-not-opening.md"

- truth: "Test pattern acikken display hedefi degisince eski overlay kapanir, yeni hedefte tek aktif overlay acilir."
  status: failed
  reason: "User reported: test patern açılmıyor overview yok"
  severity: major
  test: 7
  root_cause: "Display switch state akisi var, ancak backend open_display_overlay gorunur overlay uretmedigi icin tek aktif overlay davranisi sahada gozlenemiyor."
  artifacts:
    - path: "src-tauri/src/commands/calibration.rs"
      issue: "display switchte overlay acma state guncelleme ile sinirli"
    - path: "src/features/calibration/state/displayTargetState.ts"
      issue: "akisin dogrulugu backend'in gercek overlay acmasina bagli"
  missing:
    - "hedef monitor icin gercek overlay acma/kapama implementasyonu"
    - "display switchte eski overlay kapat-yeni overlay ac davranisinin runtime dogrulamasi"
  debug_session: ".planning/debug/test-pattern-overlay-missing-on-display-switch.md"

- truth: "Overlay open fail durumunda test pattern toggle bloke olur ve kullaniciya acik reason metni gosterilir."
  status: failed
  reason: "User reported: overlay görünmüyor bunu göremiyorum"
  severity: major
  test: 8
  root_cause: "Blocked reason metni UI'da mevcut olsa da open_display_overlay gercek overlay acmadigi icin fail senaryosu sahada dogrulanabilir sekilde olusmuyor."
  artifacts:
    - path: "src-tauri/src/commands/calibration.rs"
      issue: "open_display_overlay state-only davranis"
    - path: "src/features/calibration/ui/CalibrationOverlay.tsx"
      issue: "blockedReason yalnizca overlay akisinda gorunur, gorunur overlay olmayinca kullanici gormuyor"
  missing:
    - "gercek overlay open-fail senaryosunun backend'de olusturulmasi ve reason'in tasinmasi"
    - "blocked reason mesajinin fail akisinda kullaniciya guvenilir sekilde sunulmasi"
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
