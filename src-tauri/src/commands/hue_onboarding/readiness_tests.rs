//! Area-readiness ownership (our own stream vs. a foreign one) and area-list
//! payload parsing.

use super::readiness::{
    evaluate_area_readiness, parse_area_list_payload, ActiveStreamerView, HueEntertainmentArea,
    ACTIVE_STREAMER_REASON,
};

// ── readiness ownership ──────────────────────────────────────────────

fn held_area() -> HueEntertainmentArea {
    HueEntertainmentArea {
        id: "area-1".to_string(),
        name: "TV".to_string(),
        room_name: None,
        channel_count: 3,
        active_streamer: true,
    }
}

/// While our own session streams, the bridge reports us as the area's
/// active streamer. That must not read as a foreign session holding it.
#[test]
fn our_own_session_is_not_a_foreign_active_streamer() {
    let response = evaluate_area_readiness(&[held_area()], "area-1", ActiveStreamerView::Ours);
    assert_eq!(response.status.code, "HUE_STREAM_READY");
    assert!(response.readiness.ready);
    assert!(response.readiness.reasons.is_empty());
}

#[test]
fn a_streamer_that_is_not_ours_blocks_with_the_sentinel() {
    let response = evaluate_area_readiness(&[held_area()], "area-1", ActiveStreamerView::Foreign);
    assert_eq!(response.status.code, "HUE_STREAM_NOT_READY");
    assert_eq!(
        response.readiness.reasons,
        vec![ACTIVE_STREAMER_REASON.to_string()]
    );
}

/// Ownership only relaxes the streamer check, never the others.
#[test]
fn our_session_does_not_excuse_an_area_with_no_channels() {
    let mut area = held_area();
    area.channel_count = 0;
    let response = evaluate_area_readiness(&[area], "area-1", ActiveStreamerView::Ours);
    assert!(!response.readiness.ready);
    assert!(!response
        .readiness
        .reasons
        .contains(&ACTIVE_STREAMER_REASON.to_string()));
}

// ── area list ────────────────────────────────────────────────────────

/// The names deliberately mix cases so that a plain byte-order sort gives a
/// *different* answer — ASCII puts every capital ahead of every lowercase,
/// so `["alpha","Beta","Gamma","delta"]` would come back as
/// `Beta, Gamma, alpha, delta`. Same-case data would pass either way and
/// prove nothing.
#[test]
fn areas_come_back_sorted_case_insensitively_by_name() {
    let payload = r#"{"data":[
        {"id":"d","metadata":{"name":"delta"},"channels":[]},
        {"id":"b","metadata":{"name":"Beta"},"channels":[]},
        {"id":"g","metadata":{"name":"Gamma"},"channels":[]},
        {"id":"a","metadata":{"name":"alpha"},"channels":[]}
    ]}"#;

    let areas = parse_area_list_payload(payload).expect("valid payload");

    let names: Vec<&str> = areas.iter().map(|a| a.name.as_str()).collect();
    assert_eq!(names, vec!["alpha", "Beta", "delta", "Gamma"]);
}

/// `active_streamer` is what surfaces HUE_STREAM_NOT_READY_ACTIVE_STREAMER
/// later, so a present-but-null value must read as "free", not "in use".
#[test]
fn a_null_active_streamer_means_the_area_is_free() {
    let payload = r#"{"data":[
        {"id":"a","metadata":{"name":"Free"},"channels":[],"active_streamer":null},
        {"id":"b","metadata":{"name":"Taken"},"channels":[],"active_streamer":{"rid":"x"}}
    ]}"#;

    let areas = parse_area_list_payload(payload).expect("valid payload");

    assert!(!areas[0].active_streamer, "explicit null is not a streamer");
    assert!(areas[1].active_streamer);
}

#[test]
fn a_channel_count_is_read_from_the_channel_array_length() {
    let payload = r#"{"data":[
        {"id":"a","metadata":{"name":"Room"},"channels":[{"channel_id":0},{"channel_id":1}]}
    ]}"#;

    let areas = parse_area_list_payload(payload).expect("valid payload");

    assert_eq!(areas[0].channel_count, 2);
}

#[test]
fn an_area_with_no_metadata_name_still_parses_with_a_placeholder() {
    let payload = r#"{"data":[{"id":"a","channels":[]}]}"#;

    let areas = parse_area_list_payload(payload).expect("valid payload");

    assert_eq!(areas[0].name, "Unnamed Area");
}

#[test]
fn a_payload_with_no_data_array_is_an_error_not_an_empty_list() {
    assert!(parse_area_list_payload(r#"{"errors":[]}"#).is_err());
    assert!(parse_area_list_payload("not json").is_err());
}
