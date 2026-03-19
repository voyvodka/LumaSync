---
phase: 01-app-shell-and-baseline-defaults
verified: 2026-03-19T13:11:45Z
status: human_needed
score: 9/9 must-haves verified
human_verification:
  - test: "Launch app via `yarn tauri dev` and confirm tray icon appears"
    expected: "App starts without errors and a tray icon is visible in the system tray"
    why_human: "Tray icon rendering and OS-level integration cannot be verified programmatically without running the app"
  - test: "Right-click tray icon → click 'Open Settings'"
    expected: "Full settings window opens with sidebar (General, Startup & Tray, Language, About & Logs, Device) and default section is General"
    why_human: "Window display and sidebar rendering require visual and interactive verification"
  - test: "On a fresh install (no prior state), observe the language in the settings window"
    expected: "UI is rendered in English (labels, titles, descriptions are all English text)"
    why_human: "First-launch locale rendering must be visually confirmed; automated tests prove policy logic but not actual UI render"
---

# Phase 1: App Shell & Baseline Defaults — Verification Report

**Phase Goal:** Kullanici uygulamayi tray odakli sekilde calistirip ayarlar penceresine ulasabilir; ilk acilis varsayimi dogru sekilde uygulanir.
**Verified:** 2026-03-19T13:11:45Z
**Status:** human_needed
**Re-verification:** No — initial verification

---

## Goal Achievement

### Observable Truths

| #  | Truth                                                                    | Status     | Evidence                                                                           |
|----|--------------------------------------------------------------------------|------------|------------------------------------------------------------------------------------|
| 1  | User can launch the app and see it running in the system tray            | ? HUMAN    | Rust tray code is fully wired (`lib.rs`); needs visual confirmation at runtime     |
| 2  | User can open the full settings window from the tray at any time         | ? HUMAN    | `open-settings` menu item → `show_and_focus_settings()` fully implemented; needs runtime test |
| 3  | User sees English as the default language on first launch                | ✓ VERIFIED | `resolveInitialLanguage()` returns `"en"` when no language persisted; 3 automated tests pass |

**Score:** 9/9 must-haves verified (3 truths: 2 automated+structural, 1 automated test; all pass — human needed for runtime visual confirmation only)

---

## Required Artifacts

### Plan 01-01 Artifacts (UX-01 — Tray Shell)

| Artifact                                 | Provides                                                        | Exists | Substantive | Wired      | Status      |
|------------------------------------------|-----------------------------------------------------------------|--------|-------------|------------|-------------|
| `src-tauri/src/lib.rs`                   | Single-instance, tray menu wiring, show/focus lifecycle hooks   | ✓      | ✓ (148 loc) | ✓ wired    | ✓ VERIFIED  |
| `src/features/tray/trayController.ts`    | Frontend bridge for Open Settings and Quit tray actions         | ✓      | ✓ (57 loc)  | ✓ wired    | ✓ VERIFIED  |
| `src/shared/contracts/shell.ts`          | Canonical tray menu IDs and shell state contract exports        | ✓      | ✓ (96 loc)  | ✓ imported | ✓ VERIFIED  |
| `scripts/verify/phase01-shell-contracts.mjs` | 31-check automated contract verifier                        | ✓      | ✓ (190 loc) | ✓ runs 0   | ✓ VERIFIED  |
| `src/features/shell/windowLifecycle.ts`  | Shell state load/save, restore, monitor-bounds guard            | ✓      | ✓ (159 loc) | ✓ wired    | ✓ VERIFIED  |

### Plan 01-03 Artifacts (UX-01 — Settings Scaffold)

| Artifact                                       | Provides                                              | Exists | Substantive | Wired      | Status      |
|------------------------------------------------|-------------------------------------------------------|--------|-------------|------------|-------------|
| `src/features/settings/SettingsLayout.tsx`     | Settings scaffold with sidebar + 5 baseline sections  | ✓      | ✓ (106 loc) | ✓ in App.tsx | ✓ VERIFIED  |
| `src/features/persistence/shellStore.ts`       | Public API for shell state load/save/reset            | ✓      | ✓ (56 loc)  | ✓ imported | ✓ VERIFIED  |
| `docs/manual/phase-01-tray-checklist.md`       | Repeatable manual tray UX checklist (7 sections)      | ✓      | ✓ (157 loc) | ✓ standalone | ✓ VERIFIED  |

### Plan 01-02 Artifacts (I18N-02 — Language Baseline)

| Artifact                                              | Provides                                                 | Exists | Substantive | Wired      | Status      |
|-------------------------------------------------------|----------------------------------------------------------|--------|-------------|------------|-------------|
| `src/features/i18n/languagePolicy.ts`                 | Deterministic first-launch language selection policy     | ✓      | ✓ (73 loc)  | ✓ in main.tsx | ✓ VERIFIED  |
| `src/features/settings/sections/LanguageSection.tsx`  | Runtime language selector UI with immediate apply        | ✓      | ✓ (67 loc)  | ✓ in SettingsLayout | ✓ VERIFIED  |
| `src/features/i18n/default-language.test.ts`          | Automated proof: first-launch + persisted override tests | ✓      | ✓ (92 loc)  | ✓ 3/3 pass | ✓ VERIFIED  |
| `src/features/i18n/i18n.ts`                           | i18next runtime with EN/TR resources, English fallback   | ✓      | ✓ (72 loc)  | ✓ in providers.tsx | ✓ VERIFIED  |
| `src/app/providers.tsx`                               | I18nextProvider composition for app tree                 | ✓      | ✓ (31 loc)  | ✓ in main.tsx | ✓ VERIFIED  |
| `src/locales/en/common.json`                          | English baseline translations                            | ✓      | ✓ exists    | ✓ in i18n.ts | ✓ VERIFIED  |
| `src/locales/tr/common.json`                          | Turkish baseline translations                            | ✓      | ✓ exists    | ✓ in i18n.ts | ✓ VERIFIED  |
| `vitest.config.ts`                                    | Vitest unit test configuration                           | ✓      | ✓ exists    | ✓ used     | ✓ VERIFIED  |

---

## Key Link Verification

### Plan 01-01 Key Links

| From                              | To                                           | Via                                              | Pattern                          | Status      |
|-----------------------------------|----------------------------------------------|--------------------------------------------------|----------------------------------|-------------|
| `src-tauri/src/lib.rs`            | `src/features/tray/trayController.ts`        | `open-settings` and `quit` tray menu actions     | `"open-settings"\|"quit"`        | ✓ WIRED     |
| `src/features/shell/windowLifecycle.ts` | `src/features/persistence/shellStore.ts` | Persist/restore window size, position, section   | `loadShellState\|saveShellState` | ✓ WIRED     |

**Evidence:**
- `lib.rs` line 121: `"open-settings" => show_and_focus_settings(app)`
- `lib.rs` line 127: `"quit" => safe_quit(app)`
- `windowLifecycle.ts` exports both `loadShellState` (line 32) and `saveShellState` (line 41); `shellStore.ts` imports and delegates to both
- `App.tsx` line 22: `import { initWindowLifecycle, loadShellState, saveShellState } from "./features/shell/windowLifecycle"`

### Plan 01-03 Key Links

| From               | To                                        | Via                             | Pattern           | Status      |
|--------------------|-------------------------------------------|---------------------------------|-------------------|-------------|
| `src/App.tsx`      | `src/features/settings/SettingsLayout.tsx`| Settings shell mount + routing  | `SettingsLayout`  | ✓ WIRED     |
| `windowLifecycle.ts` | `shellStore.ts`                         | Load/save shell state + hint    | `loadShellState\|saveShellState\|trayHintShown` | ✓ WIRED |

**Evidence:**
- `App.tsx` line 17: `import { SettingsLayout }` and line 87: `<SettingsLayout activeSection={...} onSectionChange={...} />`
- `shellStore.ts` line 17: `import { loadShellState, saveShellState } from "../shell/windowLifecycle"`
- `windowLifecycle.ts` line 74: `if (!state.trayHintShown)` / line 75: `await saveShellState({ trayHintShown: true })`

### Plan 01-02 Key Links

| From                                           | To                                         | Via                                     | Pattern              | Status      |
|------------------------------------------------|--------------------------------------------|-----------------------------------------|----------------------|-------------|
| `src/features/settings/sections/LanguageSection.tsx` | `src/features/i18n/i18n.ts`         | Immediate `changeLanguage` invocation   | `changeLanguage`     | ✓ WIRED     |
| `src/features/i18n/languagePolicy.ts`          | `src/features/persistence/shellStore.ts`   | Read/write persisted language key       | `language`           | ✓ WIRED     |

**Evidence:**
- `LanguageSection.tsx` line 19: `import { changeLanguage, ... } from "../../i18n/i18n"`, line 36: `await changeLanguage(lang)`
- `LanguageSection.tsx` line 40: `await shellStore.save({ language: lang })`
- `languagePolicy.ts` line 27: `import { shellStore }` and line 58: `const persisted = state.language`
- `main.tsx`: full i18n bootstrap chain — `resolveInitialLanguage()` → `initI18n(language)` → `<Providers>` (I18nextProvider) → `<App />`

---

## Requirements Coverage

| Requirement | Source Plan | Description                                               | Status      | Evidence                                                                 |
|-------------|-------------|-----------------------------------------------------------|-------------|--------------------------------------------------------------------------|
| UX-01       | 01-01, 01-03 | User can run the app from system tray and open full settings window on demand | ✓ SATISFIED | `lib.rs` tray with `show_and_focus_settings()`, single-instance plugin, `SettingsLayout` wired in `App.tsx` |
| I18N-02     | 01-02       | App defaults to English on first launch                   | ✓ SATISFIED | `resolveInitialLanguage()` returns `"en"` when no language in store; 3/3 automated tests pass |

**REQUIREMENTS.md Traceability Check:**
- UX-01 → Phase 1 → marked `[x]` Complete ✓
- I18N-02 → Phase 1 → marked `[x]` Complete ✓

No orphaned requirements detected for Phase 1.

---

## Automated Verification Results

| Command                                                          | Result       | Notes                                  |
|------------------------------------------------------------------|--------------|----------------------------------------|
| `node scripts/verify/phase01-shell-contracts.mjs`               | ✓ 31/31 PASS | All exports, IDs, and ShellState fields verified |
| `cargo check --manifest-path src-tauri/Cargo.toml`              | ✓ PASS       | `Finished dev profile — no errors`     |
| `yarn tsc --noEmit`                                              | ✓ PASS       | No TypeScript errors                   |
| `yarn vitest run src/features/i18n/default-language.test.ts`    | ✓ 3/3 PASS   | first-launch English, persisted override, unknown locale fallback |

---

## Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `src/App.tsx` | 12 | Comment: "Defers i18n provider to Plan 02 (placeholder pass-through for now)" | ℹ️ Info | Stale comment — i18n IS wired in Plan 02; comment is a historical artifact, not actual deferred behavior |
| `src/features/settings/sections/GeneralSection.tsx` | 12–14 | Placeholder content: "General application preferences will be available here" | ℹ️ Info | Expected Phase 1 scope — General section is intentionally a placeholder per plan scope |
| `src/features/settings/sections/DeviceSection.tsx` | 12–14 | Placeholder content: "LED device configuration will be available after Phase 2" | ℹ️ Info | Expected Phase 1 scope — Device section is intentionally deferred to Phase 2 per plan |

**No blockers found.** All placeholder sections are explicitly in-scope per Phase 1 plan (General and Device sections are Phase 2+ scope). The stale comment in `App.tsx` line 12 is cosmetic only — i18n is fully wired.

---

## Human Verification Required

All automated checks pass. The following items require running the app (`yarn tauri dev`) for final confirmation:

### 1. Tray Icon Presence

**Test:** Run `yarn tauri dev` and observe the macOS menu bar / system tray
**Expected:** LumaSync tray icon appears (custom icon from `tauri.conf.json`); no build errors in terminal
**Why human:** OS-level tray icon rendering cannot be verified without executing the Tauri runtime

### 2. Settings Window Opens From Tray

**Test:** Right-click the tray icon → click "Open Settings"
**Expected:** Full settings window opens with:
- Sidebar showing: General (active), Startup & Tray, Language, About & Logs, Device
- Clicking any sidebar item switches content without page reload
- Window has correct minimum size (≥720×480)
**Why human:** Window rendering and sidebar interactivity require visual + interactive verification

### 3. English Default on First Launch

**Test:** On a fresh state (or after deleting the plugin-store data), launch the app and open Settings > Language
**Expected:** English radio option is selected; all UI text (titles, descriptions, labels) is in English
**Why human:** Automated tests prove the policy returns `"en"`, but actual i18next rendering in the window requires visual confirmation

### 4. Close-to-Tray Behavior

**Test:** Click the window close button (X)
**Expected:** Window hides (not quits); tray icon remains; first time shows console hint message
**Why human:** Requires observing OS-level window hide vs. process termination

### 5. Single-Instance Focus (Optional)

**Test:** With app running, try to launch a second instance
**Expected:** Second launch does NOT open a new window; existing window comes to focus
**Why human:** Requires running two launch attempts

---

## Commit Verification

All 8 task commits referenced in SUMMARY files confirmed present in git log:

| Commit    | Plan  | Task                                              |
|-----------|-------|---------------------------------------------------|
| `ad5a059` | 01-01 | Shell contracts + structure verifier (feat)       |
| `efab154` | 01-01 | Tray lifecycle, single-instance, close-to-tray (feat) |
| `f5bbe30` | 01-03 | Settings shell layout + baseline sections (feat)  |
| `f2de774` | 01-03 | Shell state persistence module + smoke checklist (feat) |
| `84f1692` | 01-02 | Failing tests for resolveInitialLanguage (test)   |
| `956ebcf` | 01-02 | languagePolicy.ts + I18N-ALIGNMENT.md (feat)      |
| `251dcaa` | 01-02 | i18next runtime + LanguageSection + providers (feat) |
| `bb5c206` | 01-02 | vitest.config.ts (feat)                           |

---

## Summary

Phase 1 goal is **structurally complete**. All required artifacts exist, are substantive (no stubs in functional code), and are correctly wired together:

1. **Tray runtime** (`lib.rs`): Single-instance plugin registered first, tray menu with `open-settings`/`quit`/`startup-toggle` actions, close-to-tray interception — all implemented and compile-clean (`cargo check` passes).

2. **Settings window** (`SettingsLayout.tsx` ↔ `App.tsx`): Full sidebar + content SPA, 5 sections (2 functional: Startup/Tray + Language; 3 informational placeholders appropriate for Phase 1 scope), wired to `App.tsx` with section state restore from persistence.

3. **English default** (`languagePolicy.ts` → `i18n.ts` → `providers.tsx` → `main.tsx`): Bootstrap chain is deterministic — `resolveInitialLanguage()` → `initI18n()` → `I18nextProvider` → `<App />`. Three automated tests prove I18N-02 compliance. `yarn tsc --noEmit` and Vitest both pass.

**Only visual/runtime verification remains** — the code is correct and wired. The manual checklist (`docs/manual/phase-01-tray-checklist.md`) provides a complete 7-section test protocol for human sign-off.

---

*Verified: 2026-03-19T13:11:45Z*
*Verifier: Claude (gsd-verifier)*
