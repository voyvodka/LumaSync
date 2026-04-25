//! v1.5 G8 split of `hue_stream_lifecycle.rs` (3 200+ LOC → submodules).
//!
//! Submodule layout:
//!
//! - `frame` — HueStream binary frame builder, channel data model, RGB→XY
//! - `dtls` — DTLS 1.2 PSK handshake (cipher pinned to PSK-AES128-GCM-SHA256)
//! - `sender` — DTLS / HTTP-fallback background sender threads,
//!   entertainment_configuration activate/deactivate, channel resolution
//! - `state_store` — runtime ownership types, DTOs, state machine enums,
//!   acquire_hue_runtime, status_with / make_result helpers
//! - `retry` — bounded-retry policy, register_transient_fault /
//!   register_auth_invalid, start_with_evidence /
//!   status_refresh_with_evidence / stop_with_timeout
//! - `reconnect` — StartAbortGuard, store_active_stream_context,
//!   spawn_reconnect_monitor + internal_restart_stream
//! - `commands` — the seven `#[tauri::command]` entry points
//!
//! The parent `commands::hue_stream_lifecycle` module is kept as a thin
//! re-export shim so external callers (`lib.rs`, `lighting_mode.rs`,
//! `runtime_telemetry.rs`) can continue to import from
//! `super::hue_stream_lifecycle::*` without churn.

pub mod commands;
pub mod dtls;
pub mod frame;
pub mod reconnect;
pub mod retry;
pub mod sender;
pub mod state_store;
