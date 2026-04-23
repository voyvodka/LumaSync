//! Integration tests for `hue_onboarding.rs`.
//!
//! The module is brought in via `#[path = ...]` rather than through the
//! library crate because these tests predate the lib structure and
//! exercise private helpers (`parse_*_payload`, `verify_hue_bridge_ip_input`).
//!
//! `hue_onboarding.rs` now depends on `super::hue_http::classify_hue_response`.
//! Because the `super::` prefix resolves against the module that owns
//! `hue_onboarding`, we mount both files as siblings of the test crate
//! root: when `hue_onboarding` lives at the crate root, `super::hue_http`
//! resolves to another crate-root sibling we mount here with `#[path]`.

#[path = "../src/commands/hue_http.rs"]
#[allow(dead_code)]
mod hue_http;

#[path = "../src/commands/hue_onboarding.rs"]
#[allow(dead_code)]
mod hue_onboarding;

use std::collections::HashMap;

use hue_http::{is_hue_unauthorized_body, HueHttpFault};
use hue_onboarding::{
    build_room_archetype_index, parse_area_list_payload, parse_credentials_validation_payload,
    parse_discovery_payload, parse_pairing_payload, verify_hue_bridge_ip_input,
};

#[test]
fn discover_hue_bridges_returns_ok_code_for_valid_payload() {
    let payload = r#"[
      {"id":"bridge-1","internalipaddress":"192.168.1.50"},
      {"id":"bridge-2","internalipaddress":"192.168.1.51"}
    ]"#;

    let response = parse_discovery_payload(payload);

    assert_eq!(response.status.code, "HUE_DISCOVERY_OK");
    assert_eq!(response.bridges.len(), 2);
    assert_eq!(response.bridges[0].id, "bridge-1");
    assert_eq!(response.bridges[0].ip, "192.168.1.50");
}

#[test]
fn verify_hue_bridge_ip_rejects_invalid_ipv4() {
    let response = verify_hue_bridge_ip_input("999.20.1.300");

    assert_eq!(response.status.code, "HUE_IP_INVALID");
    assert!(response.status.details.is_some());
}

#[test]
fn pair_hue_bridge_handles_link_button_and_success_states() {
    let pending_payload = r#"[{"error":{"type":101,"description":"link button not pressed"}}]"#;
    let pending = parse_pairing_payload(pending_payload);
    assert_eq!(pending.status.code, "HUE_PAIRING_LINK_BUTTON_NOT_PRESSED");
    assert!(pending.credentials.is_none());

    let success_payload =
        r#"[{"success":{"username":"app-key-123","clientkey":"client-key-456"}}]"#;
    let success = parse_pairing_payload(success_payload);
    assert_eq!(success.status.code, "HUE_PAIRING_OK");

    let credentials = success
        .credentials
        .expect("success response should include credentials");
    assert_eq!(credentials.username, "app-key-123");
    assert_eq!(credentials.client_key, "client-key-456");
}

// ---------------------------------------------------------------------------
// G7 — pairing error-type split (v1.4 Wave 3)
// ---------------------------------------------------------------------------
//
// parse_pairing_payload owns the CLIP-body → frontend-status mapping. Lock
// the four new v1.4 codes so any future refactor that collapses them
// back onto the legacy catch-all fails loudly.

#[test]
fn pair_hue_bridge_maps_devicetype_invalid() {
    let payload =
        r#"[{"error":{"type":7,"address":"/","description":"invalid value, devicetype"}}]"#;
    let response = parse_pairing_payload(payload);
    assert_eq!(response.status.code, "HUE_PAIRING_DEVICETYPE_INVALID");
    assert!(response.credentials.is_none());
}

#[test]
fn pair_hue_bridge_type_7_without_devicetype_falls_through_to_failed() {
    // type=7 but the description hints at a different invalid value —
    // must NOT collapse onto DEVICETYPE_INVALID since the cause is unknown.
    let payload = r#"[{"error":{"type":7,"address":"/lights/1","description":"invalid value"}}]"#;
    let response = parse_pairing_payload(payload);
    assert_eq!(response.status.code, "HUE_PAIRING_FAILED");
}

#[test]
fn pair_hue_bridge_maps_rate_limited_body() {
    let payload = r#"[{"error":{"type":429,"description":"too many requests"}}]"#;
    let response = parse_pairing_payload(payload);
    assert_eq!(response.status.code, "HUE_PAIRING_RATE_LIMITED");
}

#[test]
fn pair_hue_bridge_maps_bridge_busy_body() {
    let payload = r#"[{"error":{"type":503,"description":"bridge busy"}}]"#;
    let response = parse_pairing_payload(payload);
    assert_eq!(response.status.code, "HUE_PAIRING_BRIDGE_BUSY");
}

#[test]
fn pair_hue_bridge_unknown_error_type_falls_through_to_failed() {
    let payload = r#"[{"error":{"type":999,"description":"future error"}}]"#;
    let response = parse_pairing_payload(payload);
    assert_eq!(response.status.code, "HUE_PAIRING_FAILED");
}

// ---------------------------------------------------------------------------
// G7 — room archetype enrichment (v1.4 Wave 3)
// ---------------------------------------------------------------------------
//
// `build_room_archetype_index` maps every service rid referenced by a
// CLIP v2 /resource/room payload to its parent room's archetype; then
// `parse_area_list_payload` consumes that index to annotate each
// entertainment area. Cover both golden paths and the whitelist
// fallback for archetypes the frontend contract does not know.

#[test]
fn build_room_archetype_index_maps_service_rids() {
    let payload = r#"{
      "data": [
        {
          "id": "room-1",
          "metadata": {"name": "Living", "archetype": "living_room"},
          "services": [
            {"rid": "svc-a", "rtype": "grouped_light"},
            {"rid": "svc-b", "rtype": "light"}
          ]
        },
        {
          "id": "room-2",
          "metadata": {"name": "Studio", "archetype": "man_cave"},
          "services": [
            {"rid": "svc-c", "rtype": "grouped_light"}
          ]
        }
      ]
    }"#;

    let index = build_room_archetype_index(payload.to_string());
    assert_eq!(index.get("svc-a"), Some(&"living_room".to_string()));
    assert_eq!(index.get("svc-b"), Some(&"living_room".to_string()));
    assert_eq!(index.get("svc-c"), Some(&"man_cave".to_string()));
}

#[test]
fn build_room_archetype_index_normalizes_unknown_archetype_to_other() {
    let payload = r#"{
      "data": [
        {
          "id": "room-1",
          "metadata": {"name": "Strange", "archetype": "space_station"},
          "services": [{"rid": "svc-x", "rtype": "grouped_light"}]
        }
      ]
    }"#;

    let index = build_room_archetype_index(payload.to_string());
    assert_eq!(index.get("svc-x"), Some(&"other".to_string()));
}

#[test]
fn build_room_archetype_index_tolerates_malformed_payload() {
    assert!(build_room_archetype_index(String::new()).is_empty());
    assert!(build_room_archetype_index("not json".to_string()).is_empty());
    assert!(build_room_archetype_index("{}".to_string()).is_empty());
}

#[test]
fn parse_area_list_payload_enriches_area_with_archetype_from_index() {
    let area_payload = r#"{
      "data": [
        {
          "id": "area-1",
          "metadata": {"name": "Living TV"},
          "channels": [{"channel_id": 0}, {"channel_id": 1}],
          "light_services": [
            {"rid": "svc-a", "rtype": "light"}
          ]
        }
      ]
    }"#;

    let mut index = HashMap::new();
    index.insert("svc-a".to_string(), "living_room".to_string());

    let areas = parse_area_list_payload(area_payload, &index).expect("area list should parse");
    assert_eq!(areas.len(), 1);
    assert_eq!(areas[0].id, "area-1");
    assert_eq!(areas[0].name, "Living TV");
    assert_eq!(areas[0].archetype.as_deref(), Some("living_room"));
    assert_eq!(areas[0].channel_count, 2);
    assert!(!areas[0].active_streamer);
}

#[test]
fn parse_area_list_payload_leaves_archetype_none_when_no_service_matches() {
    let area_payload = r#"{
      "data": [
        {
          "id": "area-1",
          "metadata": {"name": "Orphan"},
          "channels": [],
          "light_services": [{"rid": "svc-unknown", "rtype": "light"}]
        }
      ]
    }"#;

    let index = HashMap::new();
    let areas = parse_area_list_payload(area_payload, &index).expect("area list should parse");
    assert_eq!(areas.len(), 1);
    assert!(areas[0].archetype.is_none());
}

#[test]
fn parse_area_list_payload_resolves_archetype_via_service_locations() {
    // CLIP v2 sometimes nests the service reference inside
    // locations.service_locations[].service instead of light_services —
    // cover that path explicitly.
    let area_payload = r#"{
      "data": [
        {
          "id": "area-1",
          "metadata": {"name": "Legacy"},
          "channels": [],
          "locations": {
            "service_locations": [
              {"service": {"rid": "svc-a", "rtype": "light"}}
            ]
          }
        }
      ]
    }"#;

    let mut index = HashMap::new();
    index.insert("svc-a".to_string(), "bedroom".to_string());

    let areas = parse_area_list_payload(area_payload, &index).expect("area list should parse");
    assert_eq!(areas[0].archetype.as_deref(), Some("bedroom"));
}

#[test]
fn validate_hue_credentials_returns_coded_outcomes() {
    let invalid_payload = r#"[{"error":{"type":1,"description":"unauthorized user"}}]"#;
    let invalid = parse_credentials_validation_payload(invalid_payload);
    assert_eq!(invalid.status.code, "HUE_CREDENTIAL_INVALID");
    assert!(!invalid.valid);

    let valid_payload = r#"{"name":"Hue Bridge","bridgeid":"001788FFFE09ABCD"}"#;
    let valid = parse_credentials_validation_payload(valid_payload);
    assert_eq!(valid.status.code, "HUE_CREDENTIAL_VALID");
    assert!(valid.valid);
}

// ---------------------------------------------------------------------------
// G2 — HTTP 403 re-pair trigger whitelist (DNA critical)
// ---------------------------------------------------------------------------
//
// These tests lock the contract from `ls-hue-protocol §2.4`: a bridge 403
// may only escalate to `HueHttpFault::AuthInvalid` (and therefore to the
// frontend runtime code `AUTH_INVALID_RE_PAIR_REQUIRED`) when the body is
// shaped as a Hue CLIP unauthorized envelope with `error.type == 1`. Any
// other 403 body — CLIP `type == 7` (invalid value), reverse-proxy HTML,
// empty body — must stay `Transient` so we never trigger an unnecessary
// re-pair ceremony.

#[test]
fn unauthorized_body_whitelist_accepts_type_1_only() {
    let type_1 = r#"[{"error":{"type":1,"address":"/","description":"unauthorized user"}}]"#;
    assert!(
        is_hue_unauthorized_body(type_1),
        "type=1 must be treated as unauthorized (sole re-pair trigger)"
    );

    let type_7 = r#"[{"error":{"type":7,"address":"/lights/1","description":"invalid value"}}]"#;
    assert!(
        !is_hue_unauthorized_body(type_7),
        "type=7 invalid-value must NOT trigger re-pair"
    );

    let type_101 = r#"[{"error":{"type":101,"description":"link button not pressed"}}]"#;
    assert!(
        !is_hue_unauthorized_body(type_101),
        "type=101 link-button must NOT trigger re-pair"
    );
}

#[test]
fn unauthorized_body_whitelist_rejects_non_hue_bodies() {
    assert!(!is_hue_unauthorized_body("<html><body>403</body></html>"));
    assert!(!is_hue_unauthorized_body(""));
    assert!(!is_hue_unauthorized_body("{\"message\":\"forbidden\"}"));
    assert!(!is_hue_unauthorized_body("[]"));
    assert!(!is_hue_unauthorized_body("[{\"success\":{}}]"));
}

#[test]
fn http_fault_display_exposes_re_pair_token_for_auth_invalid() {
    // The frontend runtime status code is derived by calling `to_string()`
    // on the fault in the blocking HTTP-fallback PUT path. Lock that
    // string so the contract stays stable under future refactors.
    assert_eq!(
        HueHttpFault::AuthInvalid.to_string(),
        "AUTH_INVALID_RE_PAIR_REQUIRED"
    );
}

#[test]
fn http_fault_display_does_not_leak_re_pair_token_on_transient() {
    let transient = HueHttpFault::Transient {
        status: 403,
        body: r#"[{"error":{"type":7,"description":"invalid value"}}]"#.to_string(),
    };
    let rendered = transient.to_string();
    assert!(
        rendered.starts_with("HUE_TRANSIENT"),
        "transient must not surface the re-pair token; got: {rendered}"
    );
    assert!(
        !rendered.contains("AUTH_INVALID_RE_PAIR_REQUIRED"),
        "transient 403 body must NOT advertise the re-pair token"
    );
}

#[test]
fn http_fault_not_found_is_distinct_from_transient() {
    let not_found = HueHttpFault::NotFound.to_string();
    assert_eq!(not_found, "HUE_NOT_FOUND");
    assert!(!not_found.contains("AUTH_INVALID_RE_PAIR_REQUIRED"));
}
