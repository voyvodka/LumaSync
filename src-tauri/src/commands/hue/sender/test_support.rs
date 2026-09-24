//! Shared fixture for `channels_tests` and `dtls_loop_tests`: a single-light
//! bridge channel at the origin, dressed only in what each test overrides.

use super::super::frame::{HueAreaChannel, HueScreenRegion};

pub(super) fn bridge_channel(channel_id: u8) -> HueAreaChannel {
    HueAreaChannel {
        channel_id,
        light_ids: vec![format!("light-{channel_id}")],
        screen_region: HueScreenRegion::Center,
        position_x: 0.0,
        position_y: 0.0,
        position_z: None,
    }
}
