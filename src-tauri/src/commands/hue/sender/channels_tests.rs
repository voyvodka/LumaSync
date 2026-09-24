//! Channel placement overrides, bridge position parsing, and the per-light
//! metadata parser — the read-only helpers `channels.rs` builds a stream
//! from.

use super::super::frame::{HueAreaChannel, HueScreenRegion};
use super::super::state_store::HueChannelPlacementOverride;
use super::channels::{
    apply_channel_placements, parse_channel_position, parse_light_metadata, unique_light_ids,
    HueGamutType,
};
use super::test_support::bridge_channel;

#[test]
fn placements_are_matched_by_bridge_id_not_by_list_position() {
    // Gapped: bridge ids 0, 2, 5 at list positions 0, 1, 2. Placing id 5
    // must move the third entry, not the one sitting at index 5 — which
    // does not exist — and must leave the others alone.
    let mut channels = vec![bridge_channel(0), bridge_channel(2), bridge_channel(5)];
    let placements = vec![HueChannelPlacementOverride {
        channel_id: 5,
        position_x: -0.9,
        position_y: 0.0,
        position_z: None,
    }];

    apply_channel_placements(&mut channels, &placements);

    assert_eq!(channels[2].position_x, -0.9);
    assert_eq!(channels[0].position_x, 0.0);
    assert_eq!(channels[1].position_x, 0.0);
}

#[test]
fn the_region_is_re_derived_from_the_placed_position() {
    // The region is never carried on the wire; carrying it is what gave the
    // old override path a second writable source for one runtime fact.
    let mut channels = vec![bridge_channel(0)];
    apply_channel_placements(
        &mut channels,
        &[HueChannelPlacementOverride {
            channel_id: 0,
            position_x: -0.9,
            position_y: 0.0,
            position_z: None,
        }],
    );
    assert_eq!(channels[0].screen_region, HueScreenRegion::Left);
}

#[test]
fn an_unknown_channel_id_is_skipped_rather_than_failing_the_start() {
    // The light left the entertainment area since the placement was saved.
    let mut channels = vec![bridge_channel(0)];
    apply_channel_placements(
        &mut channels,
        &[HueChannelPlacementOverride {
            channel_id: 9,
            position_x: 1.0,
            position_y: 1.0,
            position_z: None,
        }],
    );
    assert_eq!(channels[0].position_x, 0.0);
    assert_eq!(channels[0].position_y, 0.0);
}

#[test]
fn a_position_outside_the_cube_is_clamped() {
    let mut channels = vec![bridge_channel(0)];
    apply_channel_placements(
        &mut channels,
        &[HueChannelPlacementOverride {
            channel_id: 0,
            position_x: 4.0,
            position_y: -7.5,
            position_z: None,
        }],
    );
    assert_eq!(channels[0].position_x, 1.0);
    assert_eq!(channels[0].position_y, -1.0);
}

#[test]
fn a_placed_height_changes_nothing_but_the_height() {
    let place = |position_z: Option<f32>| {
        let mut channel = bridge_channel(0);
        channel.position_z = Some(0.3);
        let mut channels = vec![channel];
        apply_channel_placements(
            &mut channels,
            &[HueChannelPlacementOverride {
                channel_id: 0,
                position_x: 0.7,
                position_y: -0.5,
                position_z,
            }],
        );
        channels.remove(0)
    };

    let without = place(None);
    let with = place(Some(0.9));
    let clamped = place(Some(4.0));

    for placed in [&with, &clamped] {
        assert_eq!(placed.position_x, without.position_x);
        assert_eq!(placed.position_y, without.position_y);
        assert_eq!(placed.screen_region, without.screen_region);
    }
    assert_eq!(
        without.position_z,
        Some(0.3),
        "no local height keeps the bridge's"
    );
    assert_eq!(with.position_z, Some(0.9));
    assert_eq!(clamped.position_z, Some(1.0));
}

#[test]
fn an_override_written_before_height_existed_still_deserializes() {
    let old: HueChannelPlacementOverride =
        serde_json::from_str(r#"{"channelId":2,"positionX":0.5,"positionY":-0.25}"#).unwrap();
    assert_eq!(old.channel_id, 2);
    assert_eq!(old.position_z, None);
    // And an absent height stays absent on the way back out.
    assert!(!serde_json::to_string(&old).unwrap().contains("positionZ"));
}

#[test]
fn a_bridge_channel_without_z_has_no_height_rather_than_zero() {
    let parse = |raw: serde_json::Value| parse_channel_position(&raw);

    assert_eq!(
        parse(serde_json::json!({ "position": { "x": 0.5, "y": -0.5 } })),
        (0.5, -0.5, None)
    );
    assert_eq!(
        parse(serde_json::json!({ "position": { "x": 0.0, "y": 0.0, "z": 0.4 } })),
        (0.0, 0.0, Some(0.4))
    );
    assert_eq!(
        parse(serde_json::json!({ "position": { "x": 0.0, "y": 0.0, "z": -3.0 } })).2,
        Some(-1.0)
    );
    assert_eq!(parse(serde_json::json!({})), (0.0, 0.0, None));
}

// -----------------------------------------------------------------------
// Per-light metadata parser
// -----------------------------------------------------------------------

#[test]
fn from_clip_str_maps_canonical_gamut_letters() {
    assert_eq!(HueGamutType::from_clip_str("A"), HueGamutType::A);
    assert_eq!(HueGamutType::from_clip_str("B"), HueGamutType::B);
    assert_eq!(HueGamutType::from_clip_str("C"), HueGamutType::C);
    assert_eq!(HueGamutType::from_clip_str("other"), HueGamutType::Other);
    assert_eq!(HueGamutType::from_clip_str(""), HueGamutType::Other);
    assert_eq!(HueGamutType::from_clip_str("Z"), HueGamutType::Other);
}

#[test]
fn parse_light_metadata_extracts_archetype_and_gamut() {
    let payload = serde_json::json!({
        "data": [{
            "id": "abc-123",
            "metadata": { "archetype": "sultan_bulb", "name": "Sofa back" },
            "color": { "gamut_type": "C" }
        }]
    });
    let meta = parse_light_metadata("abc-123", &payload).expect("metadata parsed");
    assert_eq!(meta.light_id, "abc-123");
    assert_eq!(meta.archetype.as_deref(), Some("sultan_bulb"));
    assert_eq!(meta.gamut_type, HueGamutType::C);
}

#[test]
fn parse_light_metadata_falls_back_to_other_when_gamut_missing() {
    let payload = serde_json::json!({
        "data": [{
            "id": "abc-123",
            "metadata": { "archetype": "hue_go" }
        }]
    });
    let meta = parse_light_metadata("abc-123", &payload).expect("metadata parsed");
    assert_eq!(meta.gamut_type, HueGamutType::Other);
    assert_eq!(meta.archetype.as_deref(), Some("hue_go"));
}

#[test]
fn parse_light_metadata_returns_none_on_empty_payload() {
    let payload = serde_json::json!({ "data": [] });
    assert!(parse_light_metadata("nope", &payload).is_none());
}

#[test]
fn unique_light_ids_dedupes_across_channels() {
    let channels = vec![
        HueAreaChannel {
            channel_id: 0,
            light_ids: vec!["a".to_string(), "b".to_string()],
            screen_region: HueScreenRegion::Center,
            position_x: 0.0,
            position_y: 0.0,
            position_z: None,
        },
        HueAreaChannel {
            channel_id: 1,
            light_ids: vec!["b".to_string(), "c".to_string()],
            screen_region: HueScreenRegion::Center,
            position_x: 0.0,
            position_y: 0.0,
            position_z: None,
        },
    ];
    let ids = unique_light_ids(&channels);
    assert_eq!(ids, vec!["a".to_string(), "b".to_string(), "c".to_string()]);
}
