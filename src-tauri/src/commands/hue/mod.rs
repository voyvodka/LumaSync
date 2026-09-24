//! The Hue entertainment runtime, split out of the former 3 200-line
//! `hue_stream_lifecycle.rs`.
//!
//! Submodule layout:
//!
//! - `frame` — HueStream binary frame builder, channel data model, RGB→XY
//! - `dtls` — DTLS 1.2 PSK handshake (cipher pinned to PSK-AES128-GCM-SHA256)
//! - `easing` — the DTLS sender's per-tick step towards the newest target
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
//! - `area_cache` — single-flight, generation-invalidated cache for the
//!   entertainment-area snapshot both readiness callers depend on
//! - `health` — the one background task that owns bridge reachability,
//!   credential validity, area readiness and stream health, published as
//!   `HueHealthSnapshot` on `hue://health`
//! - `light_restore` — the area's pre-stream light state, captured before the
//!   first start and written back once Hue output ends
//! - `transport` — the one HTTP layer for bridge calls: address guard,
//!   shared clients bound to the key's bridge, response size cap
//! - `bridge_identity` — bridge certificate check: Signify roots, CN =
//!   bridge id, first-use pin for self-signed bridges
//! - `pin_store` — the bridge certificate pins file in the app data dir
//! - `credential_store` — OS-keychain abstraction (macOS Keychain /
//!   Windows CredMan / Linux Secret Service), also used to migrate Hue
//!   credentials off the plaintext shellStore fields.
//!
//! The previous `zone` submodule moved to
//! `commands::room_map::hue_zone` — zones are Hue-only, see
//! docs/architecture/hue.md.

pub mod area_cache;
pub mod bridge_identity;
#[cfg(test)]
mod colour_golden_tests;
pub mod commands;
pub mod credential_store;
pub mod dtls;
pub mod easing;
pub mod frame;
pub mod health;
#[cfg(test)]
mod health_tests;
pub mod hue_config;
pub mod light_restore;
pub mod pin_store;
pub mod reconnect;
pub mod retry;
pub mod sender;
pub mod state_store;
#[cfg(test)]
pub(crate) mod test_bridge;
pub mod transport;
