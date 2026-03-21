#[path = "../src/commands/hue_onboarding.rs"]
mod hue_onboarding;

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
