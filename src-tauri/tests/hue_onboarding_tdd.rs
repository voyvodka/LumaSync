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

use hue_http::{is_hue_unauthorized_body, HueHttpFault};
use hue_onboarding::{
    parse_credentials_validation_payload, parse_discovery_payload, parse_pairing_payload,
    verify_hue_bridge_ip_input,
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
    assert_eq!(pending.status.code, "HUE_PAIRING_PENDING_LINK_BUTTON");
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
