---
phase: 06
slug: runtime-quality-controls
status: complete
nyquist_compliant: true
wave_0_complete: true
created: 2026-03-21
---

# Phase 06 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Rust unit tests (`cargo test`) + Vitest 3.x |
| **Config file** | `vitest.config.ts` (frontend), none extra for Rust |
| **Quick run command** | `cargo test --manifest-path src-tauri/Cargo.toml runtime_quality::tests::` |
| **Full suite command** | `cargo test --manifest-path src-tauri/Cargo.toml && yarn vitest run` |
| **Estimated runtime** | ~60 seconds |

---

## Sampling Rate

- **After every task commit:** Run `cargo test --manifest-path src-tauri/Cargo.toml runtime_quality::tests::`
- **After every plan wave:** Run `cargo test --manifest-path src-tauri/Cargo.toml lighting_mode::tests:: runtime_quality::tests::`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 90 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 06-01-01 | 01 | 1 | QUAL-01 | unit | `cargo test --manifest-path src-tauri/Cargo.toml runtime_quality::tests::smoothes_step_changes -- --nocapture` | ✅ `src-tauri/src/commands/runtime_quality.rs` | ✅ green |
| 06-01-02 | 01 | 1 | QUAL-01 | unit | `cargo test --manifest-path src-tauri/Cargo.toml runtime_quality::tests::resets_on_led_count_change -- --nocapture` | ✅ `src-tauri/src/commands/runtime_quality.rs` | ✅ green |
| 06-02-01 | 02 | 1 | QUAL-02 | unit | `cargo test --manifest-path src-tauri/Cargo.toml runtime_quality::tests::adapts_interval_under_pressure -- --nocapture` | ✅ `src-tauri/src/commands/runtime_quality.rs` | ✅ green |
| 06-02-02 | 02 | 1 | QUAL-02 | unit | `cargo test --manifest-path src-tauri/Cargo.toml runtime_quality::tests::coalesces_to_latest_frame -- --nocapture` | ✅ `src-tauri/src/commands/runtime_quality.rs` | ✅ green |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [x] `src-tauri/src/commands/runtime_quality.rs` — quality controller and focused QUAL-01/QUAL-02 tests
- [x] `src-tauri/src/commands/lighting_mode.rs` — integration tests for adaptive gating decisions
- [x] `src/features/mode/model/contracts.test.ts` — quality config fieldi genislemedigi icin bu plan kapsami disinda kaldi (N/A)

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Realtime mode feels smooth without visible harsh flicker | QUAL-01 | Perceptual smoothness cannot be fully asserted from unit tests | Run Ambilight on hardware for 10+ minutes with mixed content and confirm transitions remain visually smooth |
| Runtime remains stable under normal desktop load | QUAL-02 | Hardware + OS scheduling effects are environment dependent | Run capture/send while opening apps and moving windows; verify no visible stutter spikes and no recovery faults |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 90s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** complete (automated checks green for runtime_quality, lighting_mode, led_output)
