---
phase: 15-fault-recovery-and-diagnostics
plan: 02
subsystem: hue
tags: [hue, dtls, reconnect, telemetry, rust, debug]

requires:
  - phase: 10-hue-stream-lifecycle
    provides: HueRuntimeOwner, spawn_hue_dtls_sender, start_hue_stream
  - phase: 15-01
    provides: HUE_FAULT_CODES taxonomy, FullTelemetrySnapshot contract

provides:
  - spawn_reconnect_monitor — Tokio task that detects DTLS sender shutdown and triggers bounded retry
  - internal_restart_stream — Arc-based internal stream restart for reconnect flow
  - HueTelemetrySnapshot and FullTelemetrySnapshot Rust structs
  - collect_hue_telemetry — reads health metrics from HueRuntimeOwner
  - get_runtime_telemetry now returns FullTelemetrySnapshot with usb + hue fields
  - simulate_hue_fault — debug-only command that triggers DTLS shutdown signal

affects:
  - 15-03-PLAN: Frontend UI consumes FullTelemetrySnapshot shape from get_runtime_telemetry

tech-stack:
  added: []
  patterns:
    - "Arc<Mutex<HueRuntimeOwner>> for shared runtime state across reconnect monitor and main tasks"
    - "Bounded retry (3 attempts) with exponential backoff in reconnect monitor"
    - "cfg!(debug_assertions) gating for simulate_hue_fault command"

key-files:
  created: []
  modified:
    - src-tauri/src/commands/hue_stream_lifecycle.rs
    - src-tauri/src/commands/runtime_telemetry.rs
    - src-tauri/src/lib.rs

key-decisions:
  - "HueRuntimeOwner telemetry fields (stream_started_at, session_reconnect_total/success, dtls_cipher, packet_send_count) added inline rather than separate struct"
  - "HueRuntimeStateStore uses Arc<Mutex<>> for reconnect monitor thread access"
  - "build_hue_sender_with_counter returns cipher name and packet counter for telemetry collection"
  - "simulate_hue_fault only available in debug builds via cfg!(debug_assertions)"

patterns-established:
  - "Reconnect monitor spawns as separate Tokio task watching sender shutdown signal"
  - "register_transient_fault and register_auth_invalid log fault codes for telemetry"

requirements-completed: [HUE-08, HDR-02]
---

## Self-Check: PASSED

All must_haves verified:
- [x] DTLS sender thread shutdown triggers automatic reconnect attempt via monitor task
- [x] After 3 failed reconnect attempts, runtime transitions to Failed state
- [x] HueTelemetrySnapshot struct collects stream health metrics from HueRuntimeOwner
- [x] get_runtime_telemetry returns FullTelemetrySnapshot with both usb and hue fields
- [x] simulate_hue_fault command exists in debug builds and triggers shutdown signal
- [x] cargo check --lib passes with zero errors
