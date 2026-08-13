//! Room map command surface.
//!
//! Submodule layout:
//!
//! - `save_load` — `copy_background_image` and `update_hue_channel_positions`.
//!   The room-map document itself is persisted frontend-side through the
//!   shellStore, so neither command carries a `RoomMapConfig`.
//! - `hue_zone` — v1.5 W4-F2 Hue zone authoring commands
//!   (`create_hue_zone`, `update_hue_zone`, `delete_hue_zone`,
//!   `assign_channel_to_hue_zone`). The previous "logical zone" surface
//!   was removed in W4-F2; future zone kinds (`ScreenZone`, `LedZone`)
//!   will land as separate, explicit-prefix modules with their own
//!   struct shapes.
//!
//! The frontend writes the mutated room map back through the shellStore;
//! zone authoring commands do not own persistence.

pub mod hue_zone;
pub mod save_load;
