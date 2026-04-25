//! v1.5 G8 split of `hue_stream_lifecycle.rs` (3 200+ LOC → submodules).
//!
//! The Tauri command surface (`start_hue_stream`, `stop_hue_stream`,
//! `set_hue_solid_color`, `get_hue_stream_status`, …) is intentionally
//! kept stable on the parent `commands::hue_stream_lifecycle` module
//! during the in-flight refactor; the public surface will move to
//! `hue::commands` in a later commit.

pub mod dtls;
pub mod frame;
pub mod sender;
