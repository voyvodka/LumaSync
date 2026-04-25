//! Thin re-export shim for the Hue runtime.
//!
//! v1.5 G8 split: this file used to host all 3 200+ LOC of the Hue runtime
//! implementation. It now keeps only public re-exports so existing import
//! paths (`super::hue_stream_lifecycle::*` from `lib.rs`,
//! `lighting_mode.rs`, `runtime_telemetry.rs`) continue to resolve without
//! churn while the implementation lives under `commands::hue::*`.
//!
//! Submodule home of every symbol exported from here:
//!
//! - `commands::hue::frame` — `HueAreaChannel`, `HueAreaChannelInfo`,
//!   `HueColorSender`, `HueScreenRegion`
//! - `commands::hue::state_store` — runtime DTOs, ownership types,
//!   `acquire_hue_runtime`, lock-free output context helpers
//! - `commands::hue::commands` — the seven `#[tauri::command]` entry
//!   points (`start_hue_stream`, `stop_hue_stream`, `restart_hue_stream`,
//!   `set_hue_solid_color`, `get_hue_stream_status`,
//!   `get_hue_area_channels`, `simulate_hue_fault`)

// ---------------------------------------------------------------------------
// Frame & state-store types — used by lighting_mode.rs / runtime_telemetry.rs
// ---------------------------------------------------------------------------

#[allow(unused_imports)]
pub use super::hue::frame::{HueAreaChannel, HueAreaChannelInfo, HueColorSender, HueScreenRegion};

#[allow(unused_imports)]
pub use super::hue::state_store::{
    apply_hue_channels_with_context, apply_hue_color_with_context, snapshot_hue_output_context,
    HueActiveOutputContext, HueRuntimeActionHint, HueRuntimeCommandResult, HueRuntimeGateEvidence,
    HueRuntimeState, HueRuntimeStateStore, HueRuntimeStatus, HueRuntimeTriggerSource,
    HueSolidColorSnapshot, SetHueSolidColorRequest, StartHueStreamRequest,
};

// `acquire_hue_runtime`, `HueActiveStreamContext`, and `HueRuntimeOwner` are
// only consumed inside the crate (runtime_telemetry.rs reads owner fields
// directly under the lock). Kept `pub(crate)` so external callers do not
// gain visibility into the runtime's internal mutex layout.
#[allow(unused_imports)]
pub(crate) use super::hue::state_store::{
    acquire_hue_runtime, HueActiveStreamContext, HueRuntimeOwner,
};

// ---------------------------------------------------------------------------
// Tauri commands — registered by lib.rs through this re-export path
// ---------------------------------------------------------------------------

pub use super::hue::commands::{
    get_hue_area_channels, get_hue_stream_status, restart_hue_stream, set_hue_solid_color,
    simulate_hue_fault, start_hue_stream, stop_hue_stream,
};
