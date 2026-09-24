//! Background sender threads that push Hue entertainment frames to the
//! bridge, split by responsibility.
//!
//! This file is the façade; the code lives in the submodules below and the
//! paths the rest of the crate uses are re-exported here.
//!
//! - `entertainment` — CLIP v2 activate/deactivate, the deactivate dedupe
//!   token, and the shutdown-signal primitive
//! - `dtls_loop` — the 20 Hz DTLS send loop, keep-alive, and handshake
//!   bring-up (`HUE_SENDER_MIN_INTERVAL_MS` — the protocol floor)
//! - `http_fallback` — per-light PUT sender used when DTLS is unavailable,
//!   paced against the bridge's documented request budget
//! - `channels` — resolving entertainment-area channels and per-light
//!   gamut/archetype metadata from the bridge
//! - `builder` — `build_hue_sender`: DTLS first, HTTP fallback on failure
//!
//! Carved out of the original `hue_stream_lifecycle.rs`; the 50 ms (20 Hz)
//! minimum interval and the keep-alive cadence are protocol-critical and
//! must not drift (the floor: docs/architecture/hue.md).

mod builder;
mod channels;
mod dtls_loop;
mod entertainment;
mod http_fallback;

pub(crate) use builder::{build_hue_sender, SpawnedHueSender};
pub use channels::HueGamutType;
pub(crate) use channels::{
    apply_channel_placements, fetch_area_channels, fetch_light_metadata_for_channels,
    fetch_lights_for_channels, HueLightFetch, HueLightMetadata,
};
pub(crate) use entertainment::{
    deactivate_with_token, is_shutdown_signaled, signal_shutdown_complete, wait_for_shutdown,
    DeactivateToken, ShutdownSignal,
};
pub(crate) use http_fallback::{RequestPacer, HUE_HTTP_FALLBACK_MAX_REQUESTS_PER_SEC};

// Only reachable from other files' own `#[cfg(test)]` code (lighting_mode's
// worker test, and the nested test modules in state_store.rs / reconnect.rs /
// commands.rs) — every non-test caller reaches these through their defining
// submodule directly, so a non-test build sees this `use` as dead.
#[cfg(test)]
pub(crate) use dtls_loop::{DtlsSendLoop, HUE_SENDER_MIN_INTERVAL_MS};
#[cfg(test)]
pub(crate) use entertainment::new_shutdown_signal;
#[cfg(test)]
pub(crate) use http_fallback::spawn_hue_http_sender;

#[cfg(test)]
mod test_support;

#[cfg(test)]
mod channels_tests;

#[cfg(test)]
mod dtls_loop_tests;

#[cfg(test)]
mod entertainment_tests;

#[cfg(test)]
mod http_fallback_tests;
