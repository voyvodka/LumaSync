# Phase 1 — Tray UX Manual Validation Checklist

**Purpose:** Repeatable manual smoke test for UX-01 Phase 1 tray and settings shell behavior.  
**Prerequisites:** Run `yarn tauri dev` and ensure the app launches.  
**Usage:** Go through each item in order. Mark PASS/FAIL with notes.

---

## Pre-flight

- [ ] `yarn tauri dev` starts without build errors
- [ ] No TypeScript errors (`yarn tsc --noEmit` passes)
- [ ] Shell contracts verifier passes (`node scripts/verify/phase01-shell-contracts.mjs`)

---

## 1. Launch Behavior

### 1.1 Manual launch (development)
- [ ] App window opens with settings shell visible
- [ ] Sidebar shows all Phase 1 sections in order:
  - [ ] General
  - [ ] Startup & Tray
  - [ ] Language
  - [ ] About & Logs
  - [ ] Device
- [ ] Default active section is **General**
- [ ] Window has correct minimum dimensions (≥720×480)
- [ ] No console errors on startup

### 1.2 First-launch state (no persisted state)
- [ ] Window opens at safe centered position
- [ ] Active section defaults to General
- [ ] No crash or blank content area

---

## 2. Settings Navigation

### 2.1 Sidebar navigation (no-reload SPA behavior)
- [ ] Clicking **Startup & Tray** switches content without page reload
- [ ] Clicking **Language** switches content without page reload
- [ ] Clicking **About & Logs** switches content without page reload
- [ ] Clicking **Device** switches content without page reload
- [ ] Active sidebar item is highlighted visually
- [ ] Back-clicking to **General** works correctly

### 2.2 Startup & Tray section
- [ ] Toggle button is visible and labeled "Launch at login"
- [ ] Toggle reflects current autostart state correctly
- [ ] Clicking toggle updates state (check if autostart changes — may require OS permissions)
- [ ] "Minimize to tray on close" row shows "Always on" badge

### 2.3 About & Logs section
- [ ] "Ambilight" version row is visible
- [ ] "Application logs" row is visible
- [ ] No missing content or empty panels

---

## 3. Window Size and Position Persistence

### 3.1 Persist geometry on close-to-tray
1. Open settings window
2. Resize window to a custom size (e.g., drag to ~1000×700)
3. Move window to a custom position (drag to upper-left area)
4. Click tray icon → minimize to tray
5. Reopen settings from tray

- [ ] Window restores to the same custom size
- [ ] Window restores to the same custom position
- [ ] If position was off-screen, window recenters (see 3.2)

### 3.2 Monitor-bounds guard (off-screen protection)
_Note: This can be tested by editing the store file directly and setting windowX/windowY to values outside monitor bounds, then reopening._

- [ ] Window reopens at centered safe position (not off-screen)
- [ ] No crash or invisible window

---

## 4. Close-to-Tray Behavior

### 4.1 First close-to-tray: educational hint
1. If app has never been closed to tray (fresh state), open settings
2. Click the window close button (X)

- [ ] Window closes (hides to tray) — process does NOT terminate
- [ ] Tray icon is still visible in system tray
- [ ] Console log message appears: "The app is still running in the system tray..." (Phase 1 hint delivery; toast UI deferred to Phase 2+)
- [ ] `trayHintShown` flag is set to `true` in store after first close

### 4.2 Subsequent close-to-tray (hint not repeated)
1. Reopen settings from tray
2. Close settings again (second time)

- [ ] Window closes to tray
- [ ] No duplicate hint output (one-time only)

---

## 5. Section State Persistence

### 5.1 Last visited section restored on reopen
1. Open settings, navigate to **About & Logs**
2. Minimize to tray
3. Reopen from tray

- [ ] Settings opens with **About & Logs** section active (not General)
- [ ] Navigation state survives close-to-tray cycle

---

## 6. Tray Menu Actions

### 6.1 Open Settings from tray menu
- [ ] Right-click tray icon → "Open Settings" opens / focuses the window
- [ ] If window is already open, it comes to focus (not duplicated)

### 6.2 Startup Toggle from tray menu
- [ ] Right-click tray icon → "Startup Toggle" changes autostart state
- [ ] Startup & Tray settings section reflects the updated state when opened

### 6.3 Quit
- [ ] Right-click tray icon → "Quit" terminates the process
- [ ] App fully exits (no ghost process)

---

## 7. Single-Instance Behavior

- [ ] With app running, attempt to launch a second instance (run `yarn tauri dev` again or open built binary)
- [ ] Second launch does NOT create a new window
- [ ] Existing settings window comes to focus (or tray icon is focused)

---

## Result

| Section | Result | Notes |
|---------|--------|-------|
| 1. Launch Behavior | PASS / FAIL | |
| 2. Settings Navigation | PASS / FAIL | |
| 3. Window Persistence | PASS / FAIL | |
| 4. Close-to-Tray | PASS / FAIL | |
| 5. Section Persistence | PASS / FAIL | |
| 6. Tray Menu Actions | PASS / FAIL | |
| 7. Single-Instance | PASS / FAIL | |

**Overall: PASS / FAIL**  
**Validated by:**  
**Date:**  
**Version:** Phase 1 / 0.1.0

---

*This checklist covers UX-01 Phase 1 acceptance criteria. Re-run after any change to tray lifecycle, window geometry, or shell persistence code.*
