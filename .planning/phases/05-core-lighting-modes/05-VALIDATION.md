---
phase: 05
slug: core-lighting-modes
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-21
---

# Phase 05 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest 3.x |
| **Config file** | `vitest.config.ts` |
| **Quick run command** | `yarn vitest run src/features/mode/state/*.test.ts` |
| **Full suite command** | `yarn vitest run` |
| **Estimated runtime** | ~45 seconds |

---

## Sampling Rate

- **After every task commit:** Run `yarn vitest run src/features/mode/state/*.test.ts`
- **After every plan wave:** Run `yarn vitest run`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 60 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 05-01-01 | 01 | 1 | MODE-01 | unit | `yarn vitest run src/features/mode/state/modeRuntimeFlow.test.ts -t "starts ambilight mode"` | ❌ W0 | ⬜ pending |
| 05-01-02 | 01 | 1 | MODE-01 | unit | `yarn vitest run src/features/mode/state/modeRuntimeFlow.test.ts -t "stops previous mode before next"` | ❌ W0 | ⬜ pending |
| 05-02-01 | 02 | 1 | MODE-02 | unit | `yarn vitest run src/features/mode/state/modeRuntimeFlow.test.ts -t "switches to solid mode"` | ❌ W0 | ⬜ pending |
| 05-02-02 | 02 | 1 | MODE-02 | unit | `yarn vitest run src/features/mode/state/modePersistence.test.ts -t "keeps calibration while saving mode"` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src/features/mode/state/modeRuntimeFlow.test.ts` — stubs for MODE-01 lifecycle and transition invariants
- [ ] `src/features/mode/state/modePersistence.test.ts` — calibration preservation assertions for mode updates
- [ ] `src/features/mode/modeApi.test.ts` — command payload and error mapping guards

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Ambilight visual reaction matches on-screen content | MODE-01 | Requires physical LED hardware + live monitor content | Connect hardware, enable Ambilight, move high-contrast windows, verify LEDs track content without mode reset |
| Solid color output applies uniformly on strip | MODE-02 | Requires physical LED strip observation | Switch to Solid mode, set red/green/blue samples, verify full strip reflects chosen color |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 60s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
