---
phase: 04
slug: calibration-workflow
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-19
---

# Phase 04 - Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest |
| **Config file** | `vitest.config.ts` |
| **Quick run command** | `yarn vitest run src/features/calibration/model/*.test.ts` |
| **Full suite command** | `yarn vitest run` |
| **Estimated runtime** | ~45 seconds |

---

## Sampling Rate

- **After every task commit:** Run `yarn vitest run src/features/calibration/model/*.test.ts`
- **After every plan wave:** Run `yarn vitest run`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 60 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 04-01-01 | 01 | 1 | CAL-01 | unit | `yarn vitest run src/features/calibration/model/templates.test.ts -t "applies predefined template"` | ❌ W0 | ⬜ pending |
| 04-01-02 | 01 | 1 | CAL-02 | unit | `yarn vitest run src/features/calibration/model/indexMapping.test.ts -t "maps start anchor and direction"` | ❌ W0 | ⬜ pending |
| 04-01-03 | 01 | 1 | CAL-03 | unit | `yarn vitest run src/features/calibration/model/validation.test.ts -t "validates counts and gap"` | ❌ W0 | ⬜ pending |
| 04-02-01 | 02 | 2 | CAL-04 | unit | `yarn vitest run src/features/calibration/state/testPatternFlow.test.ts -t "starts and stops pattern"` | ❌ W0 | ⬜ pending |
| 04-02-02 | 02 | 2 | UX-02 | unit | `yarn vitest run src/features/calibration/state/entryFlow.test.ts -t "reuses editor state"` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠ flaky*

---

## Wave 0 Requirements

- [ ] `src/features/calibration/model/indexMapping.test.ts` - stubs for CAL-02
- [ ] `src/features/calibration/model/templates.test.ts` - stubs for CAL-01
- [ ] `src/features/calibration/model/validation.test.ts` - stubs for CAL-03
- [ ] `src/features/calibration/state/testPatternFlow.test.ts` - stubs for CAL-04
- [ ] `src/features/calibration/state/entryFlow.test.ts` - stubs for UX-02
- [ ] `yarn add -D jsdom` - only if component-level interaction tests are introduced

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Overlay gradient visually matches physical strip ordering | CAL-04 | Requires real hardware perception and physical LED observation | Open calibration editor, toggle Test Pattern, compare on-screen gradient travel with strip order across all segments |
| Unsaved changes prompt appears only when model differs from baseline | UX-02 | UX confirmation timing depends on interactive user flow | Change counts/start anchor, attempt close, verify prompt appears; revert back to baseline and verify prompt no longer appears |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 60s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
