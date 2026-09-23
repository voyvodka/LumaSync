//! The onboarding commands' network halves over the real transport, against a
//! local HTTPS bridge. They live here rather than in `hue_onboarding.rs`
//! because that file is also mounted by `tests/hue_onboarding_tdd.rs`, which
//! stubs the transport out.

use std::sync::Arc;
use std::time::Duration;

use serde_json::json;

use super::super::bridge_identity::tests::self_signed;
use super::super::bridge_identity::BridgeTrust;
use super::super::credential_store::tests::InMemoryStore;
use super::super::credential_store::{
    pair_owner, PairOwner, SecretStore, KEY_HUE_APP_KEY, KEY_HUE_BRIDGE_ID, KEY_HUE_CLIENT_KEY,
};
use super::super::pin_store::{MemoryPinStore, PinRecord, PinStore};
use super::super::test_bridge::{Reply, TestBridge, TEST_BRIDGE_ID};
use super::{build_async_client, plain_http_client};
use crate::commands::hue_onboarding::{
    pair_bridge_at, send_clip_v1, validate_app_key_at, verify_bridge_at,
};

fn client(trust: BridgeTrust, store: &Arc<MemoryPinStore>) -> reqwest::Client {
    build_async_client(&trust, store.clone(), Duration::from_secs(5)).unwrap()
}

fn paired() -> Reply {
    Reply::json(
        200,
        json!([{ "success": { "username": "new-key", "clientkey": "00112233445566778899aabbccddeeff" } }]),
    )
}

/// The owner of a new pair is the bridge its certificate names — not the
/// address, which a DHCP renewal hands to something else.
#[tokio::test]
async fn a_new_pair_is_owned_by_the_bridge_the_certificate_names() {
    let bridge = TestBridge::start(|_, _, _| paired());
    let pins = Arc::new(MemoryPinStore::default());
    let keychain = InMemoryStore::default();

    let response = pair_bridge_at(
        &client(BridgeTrust::pairing(), &pins),
        &bridge.authority,
        &keychain,
    )
    .await;

    assert_eq!(response.status.code, "HUE_PAIRING_OK");
    assert_eq!(
        keychain.get(KEY_HUE_BRIDGE_ID).unwrap().as_deref(),
        Some(TEST_BRIDGE_ID)
    );
    assert!(pins.get(TEST_BRIDGE_ID).is_some());
}

/// A bridge that has shown a Signify-signed certificate cannot be
/// impersonated with a self-signed one, even by the link-button flow: the
/// request whose answer carries the client key is never sent.
#[tokio::test]
async fn pairing_refuses_a_downgraded_certificate_before_anything_is_sent() {
    let bridge = TestBridge::start(|_, _, _| paired());
    let pins = Arc::new(MemoryPinStore::default());
    pins.set(TEST_BRIDGE_ID, &PinRecord::SignifySigned(String::new()))
        .unwrap();
    let keychain = InMemoryStore::default();

    let response = pair_bridge_at(
        &client(BridgeTrust::pairing(), &pins),
        &bridge.authority,
        &keychain,
    )
    .await;

    assert_eq!(response.status.code, "HUE_BRIDGE_IDENTITY_MISMATCH");
    assert!(response.credentials.is_none());
    assert!(bridge.requests().is_empty());
    assert_eq!(keychain.get(KEY_HUE_APP_KEY).unwrap(), None);
}

#[tokio::test]
async fn a_validated_key_rewrites_a_legacy_address_owner_to_the_bridge_id() {
    let bridge = TestBridge::start(|_, _, _| {
        Reply::json(
            200,
            json!({ "errors": [], "data": [{ "bridge_id": TEST_BRIDGE_ID }] }),
        )
    });
    let pins = Arc::new(MemoryPinStore::default());
    let keychain = InMemoryStore::default();
    keychain.set(KEY_HUE_APP_KEY, "kc-key").unwrap();
    keychain.set(KEY_HUE_CLIENT_KEY, "kc-psk").unwrap();
    keychain.set(KEY_HUE_BRIDGE_ID, "192.168.1.180").unwrap();
    let endpoint = format!("https://{}/clip/v2/resource/bridge", bridge.authority);

    let response = validate_app_key_at(
        &client(BridgeTrust::any(), &pins),
        &endpoint,
        &bridge.authority,
        "kc-key",
        &keychain,
    )
    .await;

    assert_eq!(response.status.code, "HUE_CREDENTIAL_VALID");
    assert_eq!(
        pair_owner(&keychain),
        PairOwner::Bridge(TEST_BRIDGE_ID.to_string())
    );
}

#[tokio::test]
async fn a_key_bound_to_another_bridge_is_never_sent_and_reads_as_a_mismatch() {
    let bridge = TestBridge::start(|_, _, _| Reply::ok());
    let pins = Arc::new(MemoryPinStore::default());
    let endpoint = format!("https://{}/clip/v2/resource/bridge", bridge.authority);

    let response = validate_app_key_at(
        &client(BridgeTrust::bridge("001788fffe000a01"), &pins),
        &endpoint,
        &bridge.authority,
        "kc-key",
        &InMemoryStore::default(),
    )
    .await;

    assert_eq!(response.status.code, "HUE_BRIDGE_IDENTITY_MISMATCH");
    assert!(!response.valid);
    assert!(bridge.requests().is_empty());
}

#[tokio::test]
async fn ip_verification_refuses_a_bridge_whose_config_names_another() {
    let answer = |bridgeid: &'static str| {
        move |_: &str, _: &str, _: &str| {
            Reply::json(200, json!({ "bridgeid": bridgeid, "name": "Hue Bridge" }))
        }
    };
    let pins = Arc::new(MemoryPinStore::default());
    let http = plain_http_client().unwrap();

    let same = TestBridge::start(answer("001788FFFE7E57B1"));
    let verified =
        verify_bridge_at(&client(BridgeTrust::any(), &pins), &http, &same.authority).await;
    assert_eq!(verified.status.code, "HUE_IP_VALID");

    let other = TestBridge::start(answer("001788FFFE000A01"));
    let refused =
        verify_bridge_at(&client(BridgeTrust::any(), &pins), &http, &other.authority).await;
    assert_eq!(refused.status.code, "HUE_BRIDGE_IDENTITY_MISMATCH");
    assert!(refused.bridge.is_none());
}

/// A failed TLS handshake is exactly what a downgrade attacker manufactures,
/// so it must never reach the plain-HTTP retry.
#[tokio::test]
async fn a_refused_certificate_is_not_retried_over_plain_http() {
    let bridge = TestBridge::presenting(&self_signed("not-a-bridge"), &[], |_, _, _| Reply::ok());
    let pins = Arc::new(MemoryPinStore::default());
    let http = plain_http_client().unwrap();

    let error = send_clip_v1(
        &client(BridgeTrust::any(), &pins),
        &bridge.authority,
        "/api/config",
        Some(&http),
        |client, url| client.get(url),
    )
    .await
    .expect_err("the certificate names no bridge");

    assert!(error.is_connect(), "reqwest files a TLS failure as connect");
    assert_eq!(bridge.connections(), 1, "no plain-HTTP attempt followed");
}
