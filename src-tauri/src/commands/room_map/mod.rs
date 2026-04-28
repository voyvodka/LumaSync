//! Room map command surface.
//!
//! Submodule layout:
//!
//! - `save_load` — `save_room_map`, `load_room_map`, `copy_background_image`,
//!   `update_hue_channel_positions` (the legacy room-map persistence + Hue
//!   bridge channel-position write-back).
//! - `hue_zone` — v1.5 W4-F2 Hue zone authoring commands
//!   (`create_hue_zone`, `update_hue_zone`, `delete_hue_zone`,
//!   `assign_channel_to_hue_zone`). The previous "logical zone" surface
//!   was removed in W4-F2; future zone kinds (`ScreenZone`, `LedZone`)
//!   will land as separate, explicit-prefix modules with their own
//!   struct shapes.
//!
//! The frontend round-trips the mutated `RoomMapConfig` back through
//! `save_room_map`; zone authoring commands do not own persistence.

pub mod hue_zone;
pub mod save_load;
