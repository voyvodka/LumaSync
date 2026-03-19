---
phase: 01
slug: app-shell-and-baseline-defaults
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-19
---

# Phase 01 - Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest (Wave 0 install) |
| **Config file** | `vitest.config.ts` (none yet - Wave 0 installs) |
| **Quick run command** | `yarn vitest run src/features/i18n/default-language.test.ts -t first-launch` |
| **Full suite command** | `yarn vitest run` |
| **Estimated runtime** | ~20-60 seconds |

---

## Sampling Rate

- **After every task commit:** Run `yarn vitest run src/features/i18n/default-language.test.ts -t first-launch`
- **After every plan wave:** Run `yarn vitest run`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 60 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 01-01-01 | 01 | 1 | I18N-02 | unit/integration | `yarn vitest run src/features/i18n/default-language.test.ts -t first-launch` | ❌ W0 | ⬜ pending |
| 01-01-02 | 01 | 1 | UX-01 | smoke/manual + script verify | `MISSING - Wave 0 must create docs/manual/phase-01-tray-checklist.md` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending - ✅ green - ❌ red - ⚠ flaky*

---

## Wave 0 Requirements

- [ ] `vitest.config.ts` - baseline test runner config
- [ ] `src/features/i18n/default-language.test.ts` - verifies first-launch default behavior for I18N-02
- [ ] `docs/manual/phase-01-tray-checklist.md` - repeatable manual UX-01 checklist
- [ ] `yarn add -D vitest @testing-library/react @testing-library/jest-dom jsdom`

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| App stays in tray and can reopen settings from tray menu while remaining single-instance | UX-01 | Tray interactions require OS shell behavior verification | Run app with `yarn tauri dev`; close settings to tray; reopen from tray; launch app second time and verify existing window focuses |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 60s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
