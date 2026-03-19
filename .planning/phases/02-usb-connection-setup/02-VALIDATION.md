---
phase: 02
slug: usb-connection-setup
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-19
---

# Phase 02 - Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest |
| **Config file** | `vitest.config.ts` |
| **Quick run command** | `yarn vitest run src/features/device/**/*.test.ts` |
| **Full suite command** | `yarn vitest run` |
| **Estimated runtime** | ~45 seconds |

---

## Sampling Rate

- **After every task commit:** Run `yarn vitest run src/features/device/**/*.test.ts`
- **After every plan wave:** Run `yarn vitest run`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 60 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 02-01-01 | 01 | 1 | CONN-01 | unit | `yarn vitest run src/features/device/portClassification.test.ts -t "groups supported ports first"` | ❌ W0 | ⬜ pending |
| 02-01-02 | 01 | 1 | CONN-02 | unit | `yarn vitest run src/features/device/manualConnectFlow.test.ts -t "manual fallback connect"` | ❌ W0 | ⬜ pending |
| 02-02-01 | 02 | 2 | CONN-02 | unit | `yarn vitest run src/features/device/selectionMemory.test.ts -t "persist only on successful connect"` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending - ✅ green - ❌ red - ⚠ flaky*

---

## Wave 0 Requirements

- [ ] `src/features/device/portClassification.test.ts` - stubs for CONN-01
- [ ] `src/features/device/manualConnectFlow.test.ts` - stubs for CONN-02 manual fallback flow
- [ ] `src/features/device/selectionMemory.test.ts` - stubs for success-only persistence policy

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Device panel status-card readability and action affordances | CONN-01, CONN-02 | Visual clarity and UX tone cannot be fully validated by unit tests | Open Device section, run scan/connect failure scenarios, verify inline status messaging and actions match context decisions |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 60s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
