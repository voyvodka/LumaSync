---
phase: 08
slug: stability-gate
status: draft
status: complete
nyquist_compliant: true
wave_0_complete: true
created: 2026-03-21
---

# Phase 08 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest + cargo test |
| **Config file** | `vitest.config.ts` + `src-tauri/Cargo.toml` |
| **Quick run command** | `yarn vitest run src/features/telemetry/ui/TelemetrySection.test.tsx src/features/settings/sections/GeneralSection.test.tsx` |
| **Full suite command** | `yarn test && cargo test --manifest-path src-tauri/Cargo.toml` |
| **Estimated runtime** | ~90 seconds |

---

## Sampling Rate

- **After every task commit:** Run `yarn vitest run src/features/telemetry/ui/TelemetrySection.test.tsx src/features/settings/sections/GeneralSection.test.tsx`
- **After every plan wave:** Run `yarn test && cargo test --manifest-path src-tauri/Cargo.toml`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 30 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 08-01-01 | 01 | 1 | QUAL-04 | unit | `yarn vitest run src/features/telemetry/ui/TelemetrySection.test.tsx` | ✅ | ⬜ pending |
| 08-01-02 | 01 | 1 | QUAL-04 | integration | `cargo test --manifest-path src-tauri/Cargo.toml runtime_telemetry::tests::` | ✅ | ⬜ pending |
| 08-02-01 | 02 | 2 | QUAL-04 | integration | `yarn vitest run src/features/settings/sections/GeneralSection.test.tsx` | ✅ | ✅ green |
| 08-02-02 | 02 | 2 | QUAL-04 | manual-gated | `yarn vitest run src/features/telemetry/ui/TelemetrySection.test.tsx src/features/settings/sections/GeneralSection.test.tsx` | ✅ | ✅ green |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [x] Existing infrastructure covers all phase requirements.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| 60-minute uninterrupted stability run | QUAL-04 | End-to-end runtime durability cannot be asserted from short automated tests | Run single 60-minute Ambilight-weighted session, telemetry checkpoints at 0/10/20/30/40/50/60, one unplug/replug in 20-40 minute window |
| Recovery without manual restart after controlled unplug/replug | QUAL-04 | Requires real hardware disconnect/reconnect timing and user-observable behavior | Perform one controlled unplug/replug during run; verify automatic recovery and no manual restart requirement |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 30s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** approved (QUAL-04 gate APPROVED, 2026-03-21)

## Final Gap Review

- Acik kalan QUAL-04 gap'i yok.
- Bir sonraki rerun odagi gerekmiyor; sadece regressions gorulurse phase-8 UAT runbook'u ayni kontratla tekrar calistirilir.
