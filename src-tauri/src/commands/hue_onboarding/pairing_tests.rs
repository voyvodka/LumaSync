//! Pairing-payload error mapping and credential validation, including
//! against a local stand-in for the bridge.

use super::pairing::{parse_bridge_resource_payload, parse_pairing_payload, validate_app_key_at};

// ── pairing ──────────────────────────────────────────────────────────

#[test]
fn pairing_succeeds_only_when_both_secrets_are_present() {
    let response =
        parse_pairing_payload(r#"[{"success":{"username":"app-key","clientkey":"PSK-HEX"}}]"#);

    assert_eq!(response.status.code, "HUE_PAIRING_OK");
    let credentials = response.credentials.expect("credentials on success");
    assert_eq!(credentials.username, "app-key");
    assert_eq!(credentials.client_key, "PSK-HEX");
}

/// Without `clientkey` there is no DTLS pre-shared key, so streaming could
/// never start. Reporting this as success would strand the user at the next
/// step with no explanation.
#[test]
fn a_success_missing_the_client_key_is_a_failure_not_a_partial_success() {
    let response = parse_pairing_payload(r#"[{"success":{"username":"app-key"}}]"#);

    assert_eq!(response.status.code, "HUE_PAIRING_FAILED");
    assert!(response.credentials.is_none());
}

/// Error 101 is the overwhelmingly common first-run case and the only one
/// with an action the user can take, so it must not collapse into the
/// catch-all.
#[test]
fn the_unpressed_link_button_gets_its_own_code() {
    let response = parse_pairing_payload(
        r#"[{"error":{"type":101,"description":"link button not pressed"}}]"#,
    );

    assert_eq!(response.status.code, "HUE_PAIRING_LINK_BUTTON_NOT_PRESSED");
    assert!(response.credentials.is_none());
}

#[test]
fn each_recoverable_pairing_error_keeps_its_own_code() {
    for (payload, expected) in [
        (
            r#"[{"error":{"type":7,"description":"invalid value for devicetype"}}]"#,
            "HUE_PAIRING_DEVICETYPE_INVALID",
        ),
        (
            r#"[{"error":{"type":429,"description":"too many requests"}}]"#,
            "HUE_PAIRING_RATE_LIMITED",
        ),
        (
            r#"[{"error":{"type":503,"description":"bridge busy"}}]"#,
            "HUE_PAIRING_BRIDGE_BUSY",
        ),
    ] {
        assert_eq!(parse_pairing_payload(payload).status.code, expected);
    }
}

/// Type 7 is a generic "invalid value" — only the devicetype flavour has a
/// dedicated code, and the rest must fall back rather than be mislabelled.
#[test]
fn a_type_7_that_is_not_about_devicetype_falls_back_to_the_catch_all() {
    let response =
        parse_pairing_payload(r#"[{"error":{"type":7,"description":"invalid value for x"}}]"#);

    assert_eq!(response.status.code, "HUE_PAIRING_FAILED");
}

#[test]
fn an_unknown_pairing_error_type_collapses_to_the_catch_all() {
    let response = parse_pairing_payload(r#"[{"error":{"type":9999,"description":"who knows"}}]"#);

    assert_eq!(response.status.code, "HUE_PAIRING_FAILED");
}

// ── credential validation ────────────────────────────────────────────

const BRIDGE_RESOURCE: &str =
    r#"{"errors":[],"data":[{"id":"b1","bridge_id":"ecb5fafffe123456","type":"bridge"}]}"#;

#[test]
fn a_bridge_resource_with_a_bridge_id_proves_the_credentials_work() {
    let response = parse_bridge_resource_payload(BRIDGE_RESOURCE);

    assert_eq!(response.status.code, "HUE_CREDENTIAL_VALID");
    assert_eq!(
        response.status.details.as_deref(),
        Some("bridgeId=ecb5fafffe123456")
    );
    assert!(response.valid);
}

/// The v1 public config — which the bridge serves for ANY key — must never
/// validate. Accepting its `bridgeid` is how a bogus key passed.
#[test]
fn the_public_v1_config_does_not_prove_a_key() {
    let response = parse_bridge_resource_payload(
        r#"{"name":"Hue Bridge","bridgeid":"ECB5FAFFFE123456","apiversion":"1.78.0"}"#,
    );

    assert_eq!(response.status.code, "HUE_CREDENTIAL_CHECK_FAILED");
    assert!(!response.valid);
}

/// A refusal can arrive on a 200: v1's `error.type 1` envelope or a v2
/// `errors[]` auth description.
#[test]
fn an_unauthorized_error_on_a_200_asks_for_a_re_pair() {
    for body in [
        r#"[{"error":{"type":1,"address":"/lights","description":"unauthorized user"}}]"#,
        r#"{"errors":[{"description":"unauthorized user"}],"data":[]}"#,
    ] {
        let response = parse_bridge_resource_payload(body);
        assert_eq!(response.status.code, "HUE_CREDENTIAL_INVALID", "{body}");
        assert!(!response.valid);
    }
}

/// A different error must NOT read as invalid credentials: that would send
/// the user through a re-pair they do not need.
#[test]
fn another_error_type_is_inconclusive_rather_than_invalid() {
    let response = parse_bridge_resource_payload(
        r#"[{"error":{"type":3,"description":"resource not available"}}]"#,
    );

    assert_eq!(response.status.code, "HUE_CREDENTIAL_CHECK_FAILED");
    assert!(!response.valid);
}

// ── credential validation against a local stand-in for the bridge ────

fn serve_once(
    status: &str,
    content_type: &str,
    body: &str,
) -> (String, std::thread::JoinHandle<()>) {
    use std::io::{BufRead, BufReader, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!(
        "http://{}/clip/v2/resource/bridge",
        listener.local_addr().unwrap()
    );
    let reply = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let handle = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        loop {
            let mut line = String::new();
            if reader.read_line(&mut line).unwrap() == 0 || line == "\r\n" {
                break;
            }
        }
        stream.write_all(reply.as_bytes()).unwrap();
    });
    (endpoint, handle)
}

async fn validate_against(
    status: &str,
    content_type: &str,
    body: &str,
) -> super::pairing::HueValidateCredentialsResponse {
    let (endpoint, server) = serve_once(status, content_type, body);
    let client = reqwest::Client::new();
    let store = super::super::hue::credential_store::tests::InMemoryStore::default();
    let response = validate_app_key_at(&client, &endpoint, "192.168.1.180", "bogus", &store).await;
    server.join().unwrap();
    response
}

/// The hardware case: a bogus key on a BSB002 gets the bridge's HTML 403.
#[tokio::test]
async fn a_bogus_key_answered_with_the_bridges_html_403_is_invalid() {
    let response = validate_against(
        "403 Forbidden",
        "text/html",
        super::super::hue_http::tests::BRIDGE_403_PAGE,
    )
    .await;
    assert_eq!(response.status.code, "HUE_CREDENTIAL_INVALID");
    assert!(!response.valid);
}

#[tokio::test]
async fn a_key_the_bridge_serves_its_resource_to_is_valid() {
    let response = validate_against("200 OK", "application/json", BRIDGE_RESOURCE).await;
    assert_eq!(response.status.code, "HUE_CREDENTIAL_VALID");
    assert!(response.valid);
}

/// A proxy's 403 is a reachability problem, never a dead key.
#[tokio::test]
async fn a_proxy_403_is_a_failed_check_not_an_invalid_key() {
    let response = validate_against(
        "403 Forbidden",
        "text/html",
        "<html><head><title>Forbidden</title></head></html>",
    )
    .await;
    assert_eq!(response.status.code, "HUE_CREDENTIAL_CHECK_FAILED");
}
