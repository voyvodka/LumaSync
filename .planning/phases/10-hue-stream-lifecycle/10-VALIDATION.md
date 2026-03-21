---
phase: 10
slug: hue-stream-lifecycle
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-21
---

# Phase 10 - Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Rust unit tests (`cargo test`) + Vitest 3.x |
| **Config file** | `vitest.config.ts` |
| **Quick run command** | `yarn vitest run src/features/mode/state/hueModeRuntimeFlow.test.ts` |
| **Full suite command** | `cargo test --manifest-path src-tauri/Cargo.toml && yarn vitest run` |
| **Estimated runtime** | ~45 seconds |

---

## Sampling Rate

- **After every task commit:** Run `yarn vitest run src/features/mode/state/hueModeRuntimeFlow.test.ts` or targeted `cargo test` for touched behavior.
- **After every plan wave:** Run `cargo test --manifest-path src-tauri/Cargo.toml && yarn vitest run`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 60 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 10-01-01 | 01 | 1 | HUE-05 | unit | `cargo test --manifest-path src-tauri/Cargo.toml hue_stream_lifecycle_start -- --exact` | ❌ W0 | ⬜ pending |
| 10-01-02 | 01 | 1 | HUE-06 | unit/integration | `cargo test --manifest-path src-tauri/Cargo.toml hue_stream_lifecycle_reconnect -- --exact` | ❌ W0 | ⬜ pending |
| 10-02-01 | 02 | 2 | HUE-07 | unit | `cargo test --manifest-path src-tauri/Cargo.toml hue_stream_lifecycle_stop -- --exact` | ❌ W0 | ⬜ pending |
| 10-02-02 | 02 | 2 | HUE-05,HUE-06,HUE-07 | unit | `yarn vitest run src/features/device/hueRuntimeStatusCard.test.ts` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠ flaky*

---

## Wave 0 Requirements

- [ ] `src-tauri/src/commands/hue_stream_lifecycle.rs` - lifecycle unit tests (start gate, idempotency, reconnect budget, stop cleanup)
- [ ] `src/features/device/hueRuntimeStatusCard.test.ts` - target-level and aggregate status mapping tests
- [ ] `src/features/mode/state/hueModeRuntimeFlow.test.ts` - mode-control start authority and user-stop priority tests
- [ ] Contract tests for lifecycle status/code additions in `src/shared/contracts/hue.ts`

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Dual-output runtime continuity (USB + Hue together) | HUE-06 | Needs hardware bridge/device and live runtime observation | Start both targets, simulate transient network jitter, verify one target recovering does not block the other |
| Deterministic stop + non-stream restoration | HUE-07 | Bridge state restore needs real device feedback | Start Hue stream, issue stop, verify status transitions to stopping->idle and bridge reports non-stream state |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 60s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
