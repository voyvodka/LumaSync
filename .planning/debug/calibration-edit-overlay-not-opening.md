---
status: diagnosed
trigger: "Issue truth: Settings > Calibration bolumunden Duzenle tetiklenince ayni calibration editor overlay'i yeniden acilir."
created: 2026-03-20T12:40:05Z
updated: 2026-03-20T13:18:56Z
---

## Current Focus

hypothesis: OS-level calibration overlay hic implement edilmedigi icin open komutu sadece state degistiriyor; gorunur overlay uretilmiyor
test: backend `open_display_overlay` kodunda gercek pencere/overlay olusturma adimi var mi kontrol et
expecting: pencere olusturma yoksa UI toggle donus davranisi "gorunum yok" semptomunu aciklar
next_action: root cause bulgusunu raporla (goal: find_root_cause_only)

## Symptoms

expected: Settings > Calibration bolumunden Duzenle tetiklenince ayni calibration editor overlay'i yeniden acilir.
actual: overlay acilmiyor; test pattern toggle ON gorunse de OS-level overlay gorunmuyor, checkbox geri false oluyor/gorunum yok.
errors: Kullanici raporu disinda net hata mesaji yok.
reproduction: UAT Test 2 - Settings > Calibration > Duzenle aksiyonunu tetikle.
started: UAT sirasinda kesfedildi.

## Eliminated

## Evidence

- timestamp: 2026-03-20T12:40:05Z
  checked: .planning/phases/04-calibration-workflow/04-UAT.md ve .planning/STATE.md
  found: UAT Test 2 major issue olarak kayitli; durum overlay acilmiyor ve test pattern toggle geri donuyor.
  implication: problem calibration edit entrypoint/overlay open akisinda tekrar eden bir hata olabilir.

- timestamp: 2026-03-20T12:40:33Z
  checked: kod tabaninda grep (App.tsx, CalibrationSection.tsx, CalibrationOverlay.tsx, ilgili state testleri)
  found: Settings Duzenle akisi App.tsx `openCalibrationOverlay` callback'ine bagli; toggle davranisi CalibrationOverlay + testPatternFlow/display overlay komutlarinda ilerliyor.
  implication: root cause muhtemelen UI entrypoint degil, OS-level overlay acma zincirindeki fail durumunun yonetimi.

- timestamp: 2026-03-20T12:40:57Z
  checked: App.tsx, CalibrationSection.tsx, CalibrationOverlay.tsx, testPatternFlow.ts, displayTargetState.ts
  found: Duzenle butonu overlay'i aciyor; test pattern ON adiminda once `switchActiveDisplay()` cagriliyor, blocked durumunda `flow.toggle(true)` cagrilmadan return ediliyor; catch bloğu da `toggle(false)` ile guvenli kapatma yapiyor.
  implication: kullanicinin gordugu "ON olup geri false" semptomu display overlay open path'inin fail etmesiyle birebir uyumlu.

- timestamp: 2026-03-20T12:41:28Z
  checked: src/features/calibration/calibrationApi.ts ve src-tauri/src/commands/calibration.rs
  found: `open_display_overlay` Tauri komutu gercek bir overlay window olusturmuyor; sadece display id varligini kontrol edip `OverlayState.active_display_id` set ediyor ve `OVERLAY_OPENED` donuyor.
  implication: OS-level overlay gorunmemesi beklenen sonuc; su an backend'de gorsel overlay cizimi/pencere acilisi implement edilmemis.

- timestamp: 2026-03-20T12:41:28Z
  checked: src-tauri/src altinda overlay window olusturma sinyalleri (WindowBuilder, yeni webview/window label) arama
  found: calibration overlay'e ozel pencere olusturma/konumlandirma kodu bulunmuyor; overlay komutlari command-response seviyesinde.
  implication: issue bir wiring bug'undan cok eksik implementasyon (missing OS overlay rendering path).

## Resolution

root_cause: Overlay acma basarili olsa da `CalibrationOverlay` toggle handler'i async akis icinde `event.target.checked` degerini tekrar okuyordu. Await sonrasi bu deger degistiginde istemsiz `toggle(false)` + `closeActiveDisplay()` zinciri calisip overlayi hemen kapatiyordu.
fix: Toggle niyeti handler basinda `const shouldEnable = event.currentTarget.checked;` ile sabitlendi ve tum toggle/close dallari bu sabit degerle surduruldu.
verification:
files_changed:
  - src-tauri/src/commands/calibration.rs
  - src/features/calibration/ui/CalibrationOverlay.tsx

- timestamp: 2026-03-20T13:03:10Z
  checked: UAT rerun sonucu + src-tauri/src/commands/calibration.rs + src-tauri/src/lib.rs
  found: Hata `OVERLAY_WINDOW_OPEN_FAILED: ... label already exists`; overlay kapanis adiminda `close()` kullanimi app-level `on_window_event` close intercept'ine takiliyor, pencere destroy olmadan gizli kaliyor.
  implication: Sonraki open denemesi ayni label ile cakisiyor; gorunum acilamiyor ve UI blocked state'e geciyor.

- timestamp: 2026-03-20T13:14:44Z
  checked: Yeni UAT rerun semptomu + open_overlay_window URL secimi
  found: Hata metni kaybolsa da overlay kalici degil; acilan pencere `index.html` yukleyerek uygulama lifecycle'ina bagimli davraniyor.
  implication: Overlay icin app webview yerine minimal/dedicated surface kullanmak gerekiyor.

- timestamp: 2026-03-20T13:18:56Z
  checked: Kullanici gozlemi (overlay acildiktan sonra stop/close komutlari) + CalibrationOverlay toggle handler
  found: Handler icinde `event.target.checked` await sonrasi tekrar kullanildigi icin stop/close branch'i yanlis tetiklenebiliyor.
  implication: Kisa siyahlik + hemen kapanma semptomu, overlay open fail degil, istemsiz disable zinciri.
