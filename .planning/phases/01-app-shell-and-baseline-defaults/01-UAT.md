---
status: diagnosed
phase: 01-app-shell-and-baseline-defaults
source: [01-01-SUMMARY.md, 01-03-SUMMARY.md, 01-02-SUMMARY.md]
started: 2026-03-19T10:33:08Z
updated: 2026-03-19T10:46:38Z
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
  root_cause: "Tray iki kaynaktan olusturuluyor: tauri.conf.json app.trayIcon ve Rust tarafinda TrayIconBuilder birlikte aktif"
  artifacts:
    - path: "src-tauri/src/lib.rs"
      issue: "TrayIconBuilder ile manuel tray olusturuluyor"
    - path: "src-tauri/tauri.conf.json"
      issue: "app.trayIcon config'i de tray olusturuyor"
  missing:
    - "Tek tray stratejisine dusur (config veya runtime builder; ikisi birden degil)"
  debug_session: ".planning/debug/duplicate-tray-icon.md"

- truth: "Startup toggle uygulama ici ve tray menu arasinda cift yonlu senkron kalir"
  status: failed
  reason: "User reported: tray den değişince uygulam içi anında güncelleniyor uygulama içinden güncelleyince tray güncellenmiyor bundan kaynaklı tray true uygulama false durumu olduğunda tray tam ters çalışmaya başlıyor"
  severity: major
  test: 3
  root_cause: "Tray check state gercek autostart state ile senkronize edilmiyor; event akisi tray->frontend var ama frontend->tray check update yok"
  artifacts:
    - path: "src-tauri/src/lib.rs"
      issue: "CheckMenuItem baslangici checked=false hardcoded, set_checked ile guncelleme yok"
    - path: "src/features/tray/trayController.ts"
      issue: "Autostart degisiyor ama tray item checked state'ini guncelleyen bridge yok"
    - path: "src/features/settings/sections/StartupTraySection.tsx"
      issue: "UI state degisiyor ancak tray checkmark senkronu ayrik kaliyor"
  missing:
    - "Autostart state degistiginde tray CheckMenuItem checked degerini ayni state ile set et"
    - "Uygulama acilisinda tray checkmark'i isEnabled() sonucuna gore initialize et"
  debug_session: ".planning/debug/startup-toggle-desync.md"

- truth: "Tam ekran modundan pencere kapatilip tray'e alindiginda ekran artefakti/black screen olusmamali"
  status: failed
  reason: "User reported: doğru çalışıyor fakat macos da şunu fark ettim. uygulamayı tam ekrna yapıyorum sonrasında çarpı ile pencereyi kapatınca ekran siyah kalııyor yana kaydırıyorum vs işletim sisteminde sorun yok"
  severity: major
  test: 4
  root_cause: "CloseRequested olayinda fullscreen kontrolu olmadan dogrudan prevent_close + hide uygulanmasi macOS fullscreen compositing artefakti uretiyor"
  artifacts:
    - path: "src-tauri/src/lib.rs"
      issue: "Close intercept her durumda prevent_close + hide yapiyor; fullscreen-aware gecis yok"
  missing:
    - "macOS + fullscreen durumunda once kontrollu fullscreen exit (set_fullscreen(false)) uygula"
    - "Fullscreen cikisindan sonra hide-to-tray akisini calistir"
  debug_session: ".planning/debug/macos-fullscreen-close-black-screen.md"
