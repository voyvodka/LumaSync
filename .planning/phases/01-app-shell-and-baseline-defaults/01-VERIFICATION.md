---
phase: 01-app-shell-and-baseline-defaults
verified: 2026-03-19T11:24:07Z
status: human_needed
score: 3/3 must-haves verified (static)
re_verification:
  previous_status: gaps_found
  previous_score: 2/3
  gaps_closed:
    - "macOS fullscreen close path now stages fullscreen exit then delayed hide-to-tray"
  gaps_remaining: []
  regressions: []
human_verification:
  - test: "Launch app and confirm single tray icon"
    expected: "App runs with exactly one tray icon and remains alive when window closes"
    why_human: "System tray rendering/lifecycle is OS runtime behavior"
  - test: "Repeat fullscreen close-to-tray and reopen cycles on macOS"
    expected: "Window exits fullscreen, hides to tray, and reopens responsively without black-screen artifact"
    why_human: "Compositor artifact behavior cannot be proven via static code checks"
  - test: "Fresh first launch language rendering"
    expected: "UI is English when no persisted language exists"
    why_human: "Rendered locale text on clean runtime must be observed interactively"
---

# Phase 1: App Shell and Baseline Defaults Verification Report

**Phase Goal:** Kullanici uygulamayi tray odakli sekilde calistirip ayarlar penceresine ulasabilir; ilk acilis varsayimi dogru sekilde uygulanir.
**Verified:** 2026-03-19T11:24:07Z
**Status:** human_needed
**Re-verification:** Yes — after 01-05 gap closure

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
| --- | --- | --- | --- |
| 1 | User can launch the app and see it running in the system tray. | ✓ VERIFIED (static) | Runtime tray is created from Rust `TrayIconBuilder::with_id("main-tray")` in `src-tauri/src/lib.rs:131`, and config tray duplication is removed (`src-tauri/tauri.conf.json`: no `app.trayIcon`). |
| 2 | User can open the full settings window from the tray at any time. | ✓ VERIFIED (static) | Tray click and `open-settings` both call `show_and_focus_settings` in `src-tauri/src/lib.rs:143` and `src-tauri/src/lib.rs:148`; app window mounts full settings shell via `src/App.tsx:65`. |
| 3 | User sees English as the default language on first launch. | ✓ VERIFIED | `resolveInitialLanguage()` falls back to `DEFAULT_LANGUAGE = "en"` in `src/features/i18n/languagePolicy.ts:39` and `src/features/i18n/languagePolicy.ts:72`; bootstrap applies it before render in `src/main.tsx:23`; fallback regression is covered in `src/features/i18n/default-language.test.ts:93`. |

**Score:** 3/3 truths verified (static)

### Required Artifacts

| Artifact | Expected | Status | Details |
| --- | --- | --- | --- |
| `src-tauri/src/lib.rs` | Tray-first runtime, single-instance, fullscreen-safe close flow | ✓ VERIFIED | Substantive implementation present (single-instance, tray events, staged fullscreen close). |
| `src/features/tray/trayController.ts` | Frontend tray bridge | ✓ VERIFIED | Startup toggle bridge implemented (`invoke`, tray event listener, state sync). |
| `src/shared/contracts/shell.ts` | Canonical shell IDs and persisted shell contract | ✓ VERIFIED | Exports tray IDs, section IDs/order, shell state, defaults, constraints. |
| `src/features/settings/SettingsLayout.tsx` | Full settings scaffold with required sections | ✓ VERIFIED | Renders all 5 required sections and routes by `SECTION_IDS`. |
| `src/features/persistence/shellStore.ts` | Public shell persistence API | ✓ VERIFIED | `load/save/reset` API delegates to lifecycle store functions. |
| `src/features/i18n/languagePolicy.ts` | Deterministic first-launch language policy | ✓ VERIFIED | Supported-language guard + explicit English default fallback implemented. |
| `src/features/settings/sections/LanguageSection.tsx` | Runtime language selection UI | ✓ VERIFIED | Immediate `changeLanguage` + persistence write path present. |
| `src/features/settings/sections/StartupTraySection.tsx` | Startup toggle UI with tray sync | ✓ VERIFIED | Initializes startup state, syncs tray checkmark, listens tray toggle events. |
| `src/features/i18n/default-language.test.ts` | Automated I18N-02 regression proof | ✓ VERIFIED | Covers first launch, persisted language, invalid locale, and load failure fallback. |
| `docs/manual/phase-01-tray-checklist.md` | Repeatable manual tray/fullscreen validation | ✓ VERIFIED | Includes explicit fullscreen close/reopen regression cycles and black-screen check. |
| `src-tauri/tauri.conf.json` | Single tray source (no config/runtime duplication) | ✓ VERIFIED | `app.trayIcon` is absent; tray creation is runtime-only. |

### Key Link Verification

| From | To | Via | Status | Details |
| --- | --- | --- | --- | --- |
| `src/App.tsx` | `src/features/settings/SettingsLayout.tsx` | Settings shell mount | ✓ WIRED | Imported and rendered (`src/App.tsx:16`, `src/App.tsx:65`). |
| `src/features/settings/SettingsLayout.tsx` | `src/features/settings/sections/LanguageSection.tsx` | Language section routing | ✓ WIRED | `SECTION_IDS.LANGUAGE` renders `<LanguageSection />` (`src/features/settings/SettingsLayout.tsx:22`). |
| `src/features/settings/sections/LanguageSection.tsx` | `src/features/i18n/i18n.ts` | Immediate language apply | ✓ WIRED | Calls `changeLanguage(lang)` (`src/features/settings/sections/LanguageSection.tsx:17`). |
| `src/features/i18n/languagePolicy.ts` | `src/features/persistence/shellStore.ts` | Read persisted language key | ✓ WIRED | Uses `shellStore.load()` and `state.language` (`src/features/i18n/languagePolicy.ts:57`). |
| `src/features/settings/sections/StartupTraySection.tsx` | `src/features/tray/trayController.ts` | Init/toggle/checkmark sync | ✓ WIRED | Uses `getStartupEnabled`, `setStartupTrayChecked`, `listenStartupToggle`, `toggleStartup`. |
| `src/features/tray/trayController.ts` | `src-tauri/src/lib.rs` | invoke + event bridge | ✓ WIRED | Invokes `set_tray_startup_checked` and listens `tray:startup-toggle-clicked`; Rust exposes both (`src-tauri/src/lib.rs:152`, `src-tauri/src/lib.rs:186`). |
| `src-tauri/src/lib.rs` | tray hide lifecycle | Fullscreen-aware close ordering | ✓ WIRED | On macOS fullscreen close: `set_fullscreen(false)` then delayed hide + `shell:close-to-tray` emit (`src-tauri/src/lib.rs:168`, `src-tauri/src/lib.rs:175`). |
| `src-tauri/src/lib.rs` | `src-tauri/tauri.conf.json` | Single tray strategy | ✓ WIRED | Runtime `TrayIconBuilder` + absent config tray key eliminates dual-source tray setup. |
| `docs/manual/phase-01-tray-checklist.md` | `src-tauri/src/lib.rs` | Fullscreen regression runbook | ✓ WIRED | Checklist section 4.3 validates the exact fullscreen close/reopen path implemented in Rust. |
| `src/features/i18n/default-language.test.ts` | `src/features/i18n/languagePolicy.ts` | Failure-path fallback guard | ✓ WIRED | Test 4 mocks `shellStore.load` rejection and asserts `en` fallback. |

Plan-path note: `01-03-PLAN.md` references `src/app/App.tsx`, while implementation lives in `src/App.tsx`; mount/wiring is present and functional in the current path.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| --- | --- | --- | --- | --- |
| UX-01 | 01-01, 01-03, 01-04, 01-05 | User can run from tray and open full settings on demand | ? NEEDS HUMAN | Static wiring is complete in `src-tauri/src/lib.rs` + `src/App.tsx`; runtime OS verification still required for tray visibility/focus/fullscreen compositor behavior. |
| I18N-02 | 01-02, 01-05 | App defaults to English on first launch | ✓ SATISFIED | Policy fallback in `src/features/i18n/languagePolicy.ts`, bootstrap ordering in `src/main.tsx`, fallback test in `src/features/i18n/default-language.test.ts`. |

**Requirement ID accounting (plans -> REQUIREMENTS.md):**
- Plan frontmatter IDs found across all Phase 01 plans: `UX-01`, `I18N-02`.
- Both IDs exist in `.planning/REQUIREMENTS.md` traceability (`UX-01` at `Phase 1`, `I18N-02` at `Phase 1`).
- Orphaned requirements for Phase 1: none.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| --- | --- | --- | --- | --- |
| `src-tauri/src/lib.rs` | 155 | `_ => {}` in match default arm | ℹ️ Info | Intentional no-op fallback for unknown tray menu IDs; not a stub/blocker. |

No blocker stub patterns found in 01-05 key files.

### Human Verification Required

### 1. Tray Presence and Single Icon

**Test:** Run `yarn tauri dev`, then close settings window once.
**Expected:** Exactly one tray icon remains visible and process keeps running.
**Why human:** Tray icon rendering and process visibility are OS runtime behaviors.

### 2. Fullscreen Close/Reopen Regression (macOS)

**Test:** Execute checklist section 4.3 in `docs/manual/phase-01-tray-checklist.md` for at least 3 cycles.
**Expected:** Fullscreen exits cleanly, window hides to tray, no black-screen artifact, and reopen always returns same responsive window.
**Why human:** Compositor and window-manager artifacts cannot be validated by static inspection.

### 3. First-Launch English UI

**Test:** Clear persisted shell store and relaunch app.
**Expected:** Initial UI text appears in English and Language section defaults to English.
**Why human:** Visual language render at runtime cannot be proven by source-only checks.

### Gaps Summary

No code-level blocker gap detected after 01-05. Remaining validation is runtime/manual (tray/OS behavior).

---

_Verified: 2026-03-19T11:24:07Z_
_Verifier: Claude (gsd-verifier)_
