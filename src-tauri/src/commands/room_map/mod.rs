//! Room map command surface.
//!
//! Submodule layout:
//!
//! - `save_load` — `save_room_map`, `load_room_map`, `copy_background_image`,
//!   `update_hue_channel_positions` (the legacy room-map persistence + Hue
//!   bridge channel-position write-back).
//! - `zone` — v1.5 W4-F unified zone authoring commands (`create_zone`,
//!   `update_zone`, `delete_zone`, `assign_channel_to_zone`) covering both
//!   `ZoneType::Logical` and `ZoneType::Hue` shapes. Moved out of
//!   `commands::hue::zone` because zones are no longer Hue-exclusive.
//!
//! The frontend round-trips the mutated `RoomMapConfig` back through
//! `save_room_map`; zone authoring commands do not own persistence.

pub mod save_load;
pub mod zone;
