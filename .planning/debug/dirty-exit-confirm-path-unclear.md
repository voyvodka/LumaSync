---
status: diagnosed
trigger: "Dirty degilken cikis onay modali gelmez; dirty durumda cikis denemesinde onay modali gelir."
created: 2026-03-20T12:39:59Z
updated: 2026-03-20T12:40:02Z
---

## Current Focus

hypothesis: Root cause, urun davranisindan ziyade UAT kaydinin test adimini belirsiz bir sekilde raporlamasi.
test: Kod + unit test + hardware UAT kayitlariyla davranisin aslinda dogru oldugunu ve issue'nin raporlama/netlik eksigi oldugunu capraz dogrulamak.
expecting: Tum teknik kanitlar beklenen dirty-exit davranisini destekler; yalnizca UAT raporunda "hangi kisim" belirsizligi kalir.
next_action: taniyi raporla (find_root_cause_only)

## Symptoms

expected: Clean durumda modal yok, dirty durumda modal var.
actual: bunun hangi kisim oldugu anlasilmiyor.
errors: yok
reproduction: Test 9 in UAT
started: Discovered during UAT

## Eliminated

<!-- APPEND only - prevents re-investigating -->

## Evidence

<!-- APPEND only - facts discovered -->

- timestamp: 2026-03-20T12:39:59Z
  checked: repo genelinde dirty/confirm aramasi
  found: `CalibrationOverlay.tsx` `editorState.confirmDiscard` ile modal render ediyor; `calibrationEditorState.ts` icinde `requestEditorClose` ve `isDirty` hesaplamasi var; ilgili testler `entryFlow.test.ts` ve `calibrationEditorState.test.ts` dosyalarinda mevcut.
  implication: Kapanis onay davranisinin ana kaynagi state helper + overlay baglantisi; kok neden bu hatta bulunabilir.

- timestamp: 2026-03-20T12:40:00Z
  checked: `src/features/calibration/state/calibrationEditorState.ts` ve `src/features/calibration/ui/CalibrationOverlay.tsx`
  found: `requestEditorClose` fonksiyonu `isDirty` true ise `confirmDiscard: true/shouldClose: false`, false ise `confirmDiscard: false/shouldClose: true` donuyor; overlay close/cancel butonlari bu sonucu birebir uyguluyor; modal render kosulu sadece `editorState.confirmDiscard`.
  implication: Clean durumda modal gelmemesi ve dirty durumda modal gelmesi davranisi tek ve deterministik bir karar noktasina bagli.

- timestamp: 2026-03-20T12:40:01Z
  checked: `.planning/phases/04-calibration-workflow/04-HARDWARE-UAT.md` UX-02-02 bolumu
  found: Ayni beklenti (`dirty degilken modal yok, dirty durumda modal var`) adimlandirilmis sekilde tanimli ve sonuc tablosunda UX-02-02 PASS olarak isaretli.
  implication: Uygulama davranisi daha once ayni proje icinde dogrulanmis; mevcut issue metni fonksiyonel bugdan cok testin hangi kisimda oldugunun anlasilmamasiyla uyumlu.

- timestamp: 2026-03-20T12:40:02Z
  checked: `src/features/calibration/state/calibrationEditorState.test.ts` ve `src/features/calibration/state/entryFlow.test.ts`
  found: Her iki test dosyasinda da clean durumda `shouldClose=true confirmDiscard=false`, dirty durumda `shouldClose=false confirmDiscard=true` beklentileri acikca assertion ile korunuyor.
  implication: Beklenen davranis hem kodda hem test kapsamasinda net; UAT-09 issue'si kod bugindan cok testin isaret ettigi UI adimini bulma sorunu.

## Resolution

root_cause: Test 9 (UAT-09) raporundaki sorun urun mantik hatasi degil; dirty-exit davranisinin hangi UI adiminda dogrulanacaginin belirsiz raporlanmasi. Kod tarafinda karar noktasi `requestEditorClose` ile deterministik, overlay de bunu birebir uyguluyor ve ayni senaryo hardware UAT + unit testlerde PASS.
fix:
verification:
files_changed: []
