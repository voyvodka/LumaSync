---
status: complete
phase: 01-app-shell-and-baseline-defaults
source: [01-01-SUMMARY.md, 01-03-SUMMARY.md, 01-02-SUMMARY.md]
started: 2026-03-19T10:33:08Z
updated: 2026-03-19T10:42:53Z
---

## Current Test

[testing complete]

## Tests

### 1. App Launch and Tray Presence
expected: `yarn tauri dev` ile tray icon gorunur ve settings penceresi blank olmadan acilir.
result: issue
reported: "tray de 2 tane uygulama ikonu geliyor onun disinda sorun bulunmuyor"
severity: major

### 2. Settings Navigation Surface
expected: Sol menude General, Startup & Tray, Language, About & Logs, Device bolumleri gorunur; tiklayinca sayfa yenilenmeden icerik degisir.
result: pass

### 3. Startup Toggle Behavior
expected: Startup & Tray icindeki Launch at login toggle'i gorunur, tiklaninca state degisir ve tray menu toggle aksiyonuyla senkron kalir.
result: issue
reported: "tray den değişince uygulam içi anında güncelleniyor uygulama içinden güncelleyince tray güncellenmiyor bundan kaynaklı tray true uygulama false durumu olduğunda tray tam ters çalışmaya başlıyor"
severity: major

### 4. Close-to-Tray Lifecycle
expected: Pencereyi kapatinca uygulama kapanmaz, tray'e gizlenir; ilk kapatmada bir defa tray hint logu gorunur.
result: issue
reported: "doğru çalışıyor fakat macos da şunu fark ettim. uygulamayı tam ekrna yapıyorum sonrasında çarpı ile pencereyi kapatınca ekran siyah kalııyor yana kaydırıyorum vs işletim sisteminde sorun yok"
severity: major

### 5. Reopen and Section Persistence
expected: Tray'den Open Settings ile pencere tekrar acilir ve son gidilen section korunur.
result: pass

### 6. First-Launch Language Default
expected: Kayitli dil yoksa ilk acilista Language bolumunde English secili gelir.
result: pass

### 7. Runtime Language Switch Persistence
expected: Language bolumunde EN/TR degisimi aninda uygulanir; secim kaydolur ve yeniden acilista korunur.
result: pass

## Summary

total: 7
passed: 4
issues: 3
pending: 0
skipped: 0

## Gaps

- truth: "Uygulama acildiginda tek bir tray icon gorunur"
  status: failed
  reason: "User reported: tray de 2 tane uygulama ikonu geliyor onun disinda sorun bulunmuyor"
  severity: major
  test: 1
  artifacts: []
  missing: []

- truth: "Startup toggle uygulama ici ve tray menu arasinda cift yonlu senkron kalir"
  status: failed
  reason: "User reported: tray den değişince uygulam içi anında güncelleniyor uygulama içinden güncelleyince tray güncellenmiyor bundan kaynaklı tray true uygulama false durumu olduğunda tray tam ters çalışmaya başlıyor"
  severity: major
  test: 3
  artifacts: []
  missing: []

- truth: "Tam ekran modundan pencere kapatilip tray'e alindiginda ekran artefakti/black screen olusmamali"
  status: failed
  reason: "User reported: doğru çalışıyor fakat macos da şunu fark ettim. uygulamayı tam ekrna yapıyorum sonrasında çarpı ile pencereyi kapatınca ekran siyah kalııyor yana kaydırıyorum vs işletim sisteminde sorun yok"
  severity: major
  test: 4
  artifacts: []
  missing: []
