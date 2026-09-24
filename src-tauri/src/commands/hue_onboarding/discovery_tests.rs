//! Discovery payload parsing.

use super::discovery::parse_discovery_payload;

// ── discovery ────────────────────────────────────────────────────────

/// An empty list is a legitimate answer from the cloud discovery endpoint,
/// not a failure: the manual-IP path is still open, and the code says so.
#[test]
fn an_empty_discovery_list_is_not_reported_as_a_failure() {
    let response = parse_discovery_payload("[]");

    assert_eq!(response.status.code, "HUE_DISCOVERY_EMPTY");
    assert!(response.bridges.is_empty());
}

#[test]
fn a_discovered_bridge_carries_its_ip_into_the_display_name() {
    let response = parse_discovery_payload(
        r#"[{"id":"001788fffe123456","internalipaddress":"192.168.1.50"}]"#,
    );

    assert_eq!(response.status.code, "HUE_DISCOVERY_OK");
    assert_eq!(response.bridges.len(), 1);
    assert_eq!(response.bridges[0].ip, "192.168.1.50");
    assert_eq!(response.bridges[0].id, "001788fffe123456");
    assert!(response.bridges[0].name.contains("192.168.1.50"));
}

#[test]
fn unparseable_discovery_json_fails_with_the_reason_attached() {
    let response = parse_discovery_payload("<html>gateway timeout</html>");

    assert_eq!(response.status.code, "HUE_DISCOVERY_FAILED");
    assert!(response.status.details.is_some());
}
