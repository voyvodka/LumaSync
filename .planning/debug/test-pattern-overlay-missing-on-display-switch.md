---
status: diagnosed
trigger: "Issue truth: Test pattern acikken display hedefi degisince eski overlay kapanir, yeni hedefte tek aktif overlay acilir."
created: 2026-03-20T12:40:01Z
updated: 2026-03-20T12:41:35Z
---

## Current Focus

hypothesis: `open_display_overlay` komutu sadece state flag set ediyor; OS-level overlay penceresi hic olusturulmadigi icin test pattern acik gorunmuyor ve display switch senaryosu gozlemlenemiyor
test: CalibrationOverlay -> displayTargetState -> calibrationApi -> Rust command zincirinde gercek overlay olusturma (window/surface draw) adimi var mi yok mu dogrulamak
expecting: eger hipotez dogruysa backend tarafinda overlay acma komutu sadece `active_display_id` tutup `OVERLAY_OPENED` donecek, gorsel overlay yaratmayacak
next_action: root cause tanimini sonlandir ve diagnose-only cikti hazirla

## Symptoms

expected: Display hedefi degisince eski overlay kapanir, yeni hedefte tek aktif overlay acilir.
actual: test patern açılmıyor overview yok
errors: belirtilen hata mesaji yok
reproduction: Test 7 in UAT
started: Discovered during UAT

## Eliminated

- hypothesis: display switch sirasinda UI tarafinda switchActiveDisplay hic tetiklenmiyor
  evidence: `CalibrationOverlay.tsx` icinde test pattern acikken display kartina tiklandiginda `displayTargetRef.current.switchActiveDisplay(display.id)` cagriliyor
  timestamp: 2026-03-20T12:41:12Z

## Evidence

- timestamp: 2026-03-20T12:40:28Z
  checked: test pattern/display aramalari
  found: sorun alani `src/features/calibration/ui/CalibrationOverlay.tsx` ve `src/features/calibration/state/displayTargetState.ts` etrafinda toplaniyor; display switch ve blocked reason akislarinin hepsi burada
  implication: Test 7 semptomu buyuk olasilikla UI display switch + state machine gecisi kaynakli
- timestamp: 2026-03-20T12:41:12Z
  checked: `src/features/calibration/ui/CalibrationOverlay.tsx`
  found: test pattern acikken display secimi `switchActiveDisplay(display.id)` cagiriyor; toggle ON da `switchActiveDisplay()` ile overlay acmaya calisiyor
  implication: UI tetikleme yolu mevcut, sorun UI'de aksiyonun hic cagrilmamasi degil
- timestamp: 2026-03-20T12:41:12Z
  checked: `src/features/calibration/state/displayTargetState.ts`
  found: state katmani once onceki display'i kapatip sonra `openDisplayOverlay(targetDisplayId)` cagiriyor; tek-aktif overlay mantigi kodda var
  implication: display switch algoritmasi tasarim olarak dogru; alttaki overlay implementasyonu kritik bagimlilik
- timestamp: 2026-03-20T12:41:12Z
  checked: `src-tauri/src/commands/calibration.rs`
  found: `open_display_overlay` sadece display id dogrulayip `overlay_state.active_display_id` set ediyor ve `OVERLAY_OPENED` donuyor; hicbir yerde overlay penceresi/surface olusturma veya cizim yok
  implication: OS-level overlay fiziksel olarak acilmadigi icin kullanici "test patern acilmiyor/overview yok" goruyor; Test 7'nin beklenen davranisi gozlenemez hale geliyor

## Resolution

root_cause: Backend `open_display_overlay` komutu gercek overlay renderer/window acmak yerine yalnizca bellekte active display id flag'ini guncelliyor. Bu nedenle test pattern acma ve display switch senaryolarinda UI tarafi "overlay acildi" sonucu alsa da OS-level overlay hic gorunmuyor.
fix:
verification:
files_changed: []
