---
phase: 03
slug: connection-resilience-and-health
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-19
---

# Phase 03 - Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest |
| **Config file** | `vitest.config.ts` |
| **Quick run command** | `yarn vitest run src/features/device/recoveryFlow.test.ts src/features/device/healthCheckFlow.test.ts` |
| **Full suite command** | `yarn vitest run` |
| **Estimated runtime** | ~25 seconds |

---

## Sampling Rate

- **After every task commit:** Run `yarn vitest run src/features/device/recoveryFlow.test.ts src/features/device/healthCheckFlow.test.ts`
- **After every plan wave:** Run `yarn vitest run`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 30 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 03-01-01 | 01 | 1 | CONN-03 | unit | `yarn vitest run src/features/device/recoveryFlow.test.ts` | ❌ W0 | ⬜ pending |
| 03-02-01 | 02 | 1 | CONN-04 | unit | `yarn vitest run src/features/device/healthCheckFlow.test.ts` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src/features/device/recoveryFlow.test.ts` - stubs for CONN-03 behaviors
- [ ] `src/features/device/healthCheckFlow.test.ts` - stubs for CONN-04 behaviors

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Unplug/replug real USB cable and observe auto-recovery UX | CONN-03 | Requires physical hardware state change | Connect device, unplug cable, replug, verify session restores without app restart |
| Run health check from Device panel and confirm PASS/FAIL guidance quality | CONN-04 | UX/message clarity best validated interactively | Trigger health check with both valid and invalid port states, verify clear summary + actionable next steps |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
