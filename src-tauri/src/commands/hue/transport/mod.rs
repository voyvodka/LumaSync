//! The one HTTP layer every bridge call goes through: the address guard, the
//! shared clients (certificate checked by `bridge_identity`, redirects never
//! followed), and a size cap on what a bridge may answer with.
//!
//! A client is chosen by what it may send. One built for an application key the
//! keychain says belongs to bridge X only completes a handshake with X, so the
//! key cannot be handed to whatever else answers on that address — see
//! docs/architecture/hue.md ("One transport, bound to the key's bridge").

use std::collections::HashMap;
use std::io::Read;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use reqwest::blocking::Client as BlockingClient;
use reqwest::redirect::Policy;

use super::bridge_identity::{
    bridge_id_of_certificate, identity_rejection_in, rustls_error_in, BridgeCertVerifier,
    BridgeTrust, IdentityRejection,
};
use super::credential_store::{default_store, pair_owner, PairOwner, SecretStore, KEY_HUE_APP_KEY};

/// Per-request ceiling for a bridge call.
pub(crate) const HUE_HTTP_TIMEOUT_MS: u64 = 5_000;

/// The largest body read from a bridge. The biggest real answer — a CLIP v2
/// resource list on a large install — is tens of KB; anything past this is
/// not a bridge talking.
pub(crate) const HUE_MAX_RESPONSE_BYTES: usize = 1024 * 1024;

// ---------------------------------------------------------------------------
// Address guard
// ---------------------------------------------------------------------------

mod address;
pub(crate) use address::{is_valid_bridge_addr, validate_bridge_addr};
#[cfg(test)]
mod onboarding_tests;

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

/// Which bridge a request carrying `app_key` may be sent to: the keychain
/// owner when `app_key` is the keychain's key and its owner is a bridge id,
/// otherwise any bridge (a legacy plaintext key, or a pair recorded before
/// owners were bridge ids — `adopt_bridge_owner` fixes that on first use).
pub(crate) fn trust_for_app_key(app_key: &str) -> BridgeTrust {
    trust_for_app_key_in(default_store().as_ref(), app_key)
}

pub(crate) fn trust_for_app_key_in(store: &dyn SecretStore, app_key: &str) -> BridgeTrust {
    if app_key.is_empty() {
        return BridgeTrust::any();
    }
    let keychain_key = store.get(KEY_HUE_APP_KEY).ok().flatten();
    if keychain_key.as_deref() != Some(app_key) {
        return BridgeTrust::any();
    }
    match pair_owner(store) {
        PairOwner::Bridge(bridge_id) => BridgeTrust::bridge(&bridge_id),
        PairOwner::Unscoped | PairOwner::LegacyAddress(_) => BridgeTrust::any(),
    }
}

fn crypto_provider() -> Arc<rustls::crypto::CryptoProvider> {
    static PROVIDER: OnceLock<Arc<rustls::crypto::CryptoProvider>> = OnceLock::new();
    Arc::clone(PROVIDER.get_or_init(|| Arc::new(rustls::crypto::aws_lc_rs::default_provider())))
}

fn tls_config(
    trust: &BridgeTrust,
    store: Arc<dyn SecretStore>,
) -> Result<rustls::ClientConfig, String> {
    let provider = crypto_provider();
    let verifier = BridgeCertVerifier::new(trust.clone(), store, Arc::clone(&provider));
    let mut config = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|error| error.to_string())?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(verifier))
        .with_no_client_auth();
    // A resumed session skips the verifier; every connection must meet it.
    config.resumption = rustls::client::Resumption::disabled();
    Ok(config)
}

/// Build an async bridge client. `store` holds the certificate pins; the
/// shared clients below pass the process-wide keychain store.
pub(crate) fn build_async_client(
    trust: &BridgeTrust,
    store: Arc<dyn SecretStore>,
    timeout: Duration,
) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .tls_backend_preconfigured(tls_config(trust, store)?)
        .tls_info(true)
        .https_only(true)
        .redirect(Policy::none())
        .timeout(timeout)
        .build()
        .map_err(|error| error.to_string())
}

/// Blocking twin of [`build_async_client`]. Never drop one on an async
/// runtime thread — reqwest panics tearing its inner runtime down there.
pub(crate) fn build_blocking_client(
    trust: &BridgeTrust,
    store: Arc<dyn SecretStore>,
    timeout: Duration,
) -> Result<BlockingClient, String> {
    BlockingClient::builder()
        .tls_backend_preconfigured(tls_config(trust, store)?)
        .tls_info(true)
        .https_only(true)
        .redirect(Policy::none())
        .timeout(timeout)
        .build()
        .map_err(|error| error.to_string())
}

fn default_timeout() -> Duration {
    Duration::from_millis(HUE_HTTP_TIMEOUT_MS)
}

/// One async client per trust for the process, so a poll reuses the pooled
/// connection instead of paying a TLS handshake every tick.
pub(crate) fn async_client(trust: &BridgeTrust) -> Result<reqwest::Client, String> {
    static CLIENTS: OnceLock<Mutex<HashMap<BridgeTrust, reqwest::Client>>> = OnceLock::new();
    let mut clients = CLIENTS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(client) = clients.get(trust) {
        return Ok(client.clone());
    }
    let client = build_async_client(trust, default_store(), default_timeout())?;
    clients.insert(trust.clone(), client.clone());
    Ok(client)
}

/// Blocking counterpart of [`async_client`]; cached for the same reason, and
/// because a cached client is never dropped on the wrong thread.
pub(crate) fn blocking_client(trust: &BridgeTrust) -> Result<Arc<BlockingClient>, String> {
    static CLIENTS: OnceLock<Mutex<HashMap<BridgeTrust, Arc<BlockingClient>>>> = OnceLock::new();
    let mut clients = CLIENTS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(client) = clients.get(trust) {
        return Ok(Arc::clone(client));
    }
    let client = Arc::new(build_blocking_client(
        trust,
        default_store(),
        default_timeout(),
    )?);
    clients.insert(trust.clone(), Arc::clone(&client));
    Ok(client)
}

/// For a caller with its own deadline (the quit path). Not cached: the
/// timeout is part of the client.
pub(crate) fn blocking_client_with_timeout(
    trust: &BridgeTrust,
    timeout: Duration,
) -> Result<BlockingClient, String> {
    build_blocking_client(trust, default_store(), timeout)
}

pub(crate) fn async_client_for_key(app_key: &str) -> Result<reqwest::Client, String> {
    async_client(&trust_for_app_key(app_key))
}

pub(crate) fn blocking_client_for_key(app_key: &str) -> Result<Arc<BlockingClient>, String> {
    blocking_client(&trust_for_app_key(app_key))
}

/// The only client that may speak plain HTTP to a bridge: IP verification's
/// fallback for firmware whose TLS we cannot reach. It never carries a key.
pub(crate) fn plain_http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .redirect(Policy::none())
        .timeout(default_timeout())
        .build()
        .map_err(|error| error.to_string())
}

/// Client for `discovery.meethue.com`, a public CA-signed endpoint: the
/// platform verifier stays in charge, since this call decides which address
/// is trusted as a bridge in the first place.
pub(crate) fn cloud_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(default_timeout())
        .build()
        .map_err(|error| error.to_string())
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

fn too_large() -> String {
    format!("bridge response exceeds {HUE_MAX_RESPONSE_BYTES} bytes")
}

/// A bridge body as text, refused past [`HUE_MAX_RESPONSE_BYTES`].
pub(crate) async fn read_body(mut response: reqwest::Response) -> Result<String, String> {
    if response
        .content_length()
        .is_some_and(|length| length > HUE_MAX_RESPONSE_BYTES as u64)
    {
        return Err(too_large());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|error| error.to_string())? {
        if body.len() + chunk.len() > HUE_MAX_RESPONSE_BYTES {
            return Err(too_large());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(String::from_utf8_lossy(&body).into_owned())
}

/// Blocking twin of [`read_body`].
pub(crate) fn read_body_blocking(response: reqwest::blocking::Response) -> Result<String, String> {
    let mut body = Vec::new();
    response
        .take(HUE_MAX_RESPONSE_BYTES as u64 + 1)
        .read_to_end(&mut body)
        .map_err(|error| error.to_string())?;
    if body.len() > HUE_MAX_RESPONSE_BYTES {
        return Err(too_large());
    }
    Ok(String::from_utf8_lossy(&body).into_owned())
}

/// The bridge id named by the certificate this response arrived over. `None`
/// over plain HTTP.
pub(crate) fn answering_bridge_id(response: &reqwest::Response) -> Option<String> {
    response
        .extensions()
        .get::<reqwest::tls::TlsInfo>()
        .and_then(|info| info.peer_certificate())
        .and_then(bridge_id_of_certificate)
}

/// The certificate refusal behind a failed request, if that is what it was.
pub(crate) fn identity_rejection(error: &reqwest::Error) -> Option<IdentityRejection> {
    identity_rejection_in(error)
}

/// The request failed in the TLS handshake, which reqwest files under connect
/// errors alongside a refused TCP port.
pub(crate) fn is_tls_failure(error: &reqwest::Error) -> bool {
    rustls_error_in(error).is_some()
}

/// A send error as text for `details` and logs. reqwest's own `Display`
/// stops at "error sending request", which hides a refused certificate.
pub(crate) fn send_error_text(error: &reqwest::Error) -> String {
    if let Some(tls) = rustls_error_in(error) {
        if identity_rejection(error).is_none() {
            return format!("{error}: TLS: {tls}");
        }
    }
    match identity_rejection(error) {
        Some(rejection) => rejection.to_string(),
        None => error.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::super::bridge_identity::tests::{ca_signed, self_signed, BRIDGE_A};
    use super::super::bridge_identity::{pin_account, IdentityRejection};
    use super::super::credential_store::tests::InMemoryStore;
    use super::super::credential_store::KEY_HUE_BRIDGE_ID;
    use super::super::test_bridge::{Reply, TestBridge};
    use super::*;

    #[test]
    fn a_key_is_bound_to_its_owner_only_when_it_is_the_keychain_key() {
        let store = InMemoryStore::default();
        store.set(KEY_HUE_APP_KEY, "stored-key").unwrap();
        store.set(KEY_HUE_BRIDGE_ID, "001788FFFE000A01").unwrap();
        assert_eq!(
            trust_for_app_key_in(&store, "stored-key"),
            BridgeTrust::bridge(BRIDGE_A)
        );
        assert_eq!(
            trust_for_app_key_in(&store, "other-key"),
            BridgeTrust::any()
        );

        store.set(KEY_HUE_BRIDGE_ID, "192.168.1.20").unwrap();
        assert_eq!(
            trust_for_app_key_in(&store, "stored-key"),
            BridgeTrust::any(),
            "a legacy address owner names no bridge to hold the connection to"
        );
    }

    fn ok_body() -> String {
        r#"{"errors":[],"data":[{"bridge_id":"001788fffe000a01"}]}"#.to_string()
    }

    fn answering_ok() -> impl Fn(&str, &str, &str) -> Reply + Send + Sync + 'static {
        |_, _, _| Reply::text(200, ok_body())
    }

    fn url(bridge: &TestBridge) -> String {
        format!("https://{}/clip/v2/resource/bridge", bridge.authority)
    }

    fn client(trust: BridgeTrust, store: &Arc<InMemoryStore>) -> reqwest::Client {
        build_async_client(&trust, store.clone(), Duration::from_secs(5)).unwrap()
    }

    #[tokio::test]
    async fn a_self_signed_bridge_is_pinned_on_first_contact_and_its_id_is_read_from_the_cert() {
        let bridge = TestBridge::presenting(&self_signed(BRIDGE_A), &[], answering_ok());
        let store = Arc::new(InMemoryStore::default());

        let response = client(BridgeTrust::any(), &store)
            .get(url(&bridge))
            .send()
            .await
            .unwrap();

        assert_eq!(answering_bridge_id(&response).as_deref(), Some(BRIDGE_A));
        assert_eq!(read_body(response).await.unwrap(), ok_body());
        let pinned = store.get(&pin_account(BRIDGE_A)).unwrap().unwrap();
        assert!(pinned.starts_with("sha256:"), "{pinned}");
    }

    #[tokio::test]
    async fn a_later_different_certificate_for_a_pinned_bridge_is_refused() {
        let store = Arc::new(InMemoryStore::default());
        let first = TestBridge::presenting(&self_signed(BRIDGE_A), &[], answering_ok());
        client(BridgeTrust::any(), &store)
            .get(url(&first))
            .send()
            .await
            .unwrap();

        let impostor = TestBridge::presenting(&self_signed(BRIDGE_A), &[], answering_ok());
        let error = client(BridgeTrust::any(), &store)
            .get(url(&impostor))
            .send()
            .await
            .expect_err("a changed self-signed certificate must not complete");

        assert_eq!(
            identity_rejection(&error),
            Some(IdentityRejection::CertificateChanged {
                bridge_id: BRIDGE_A.to_string()
            })
        );
        assert!(send_error_text(&error).starts_with("HUE_BRIDGE_IDENTITY_MISMATCH"));
        assert!(is_tls_failure(&error));
        assert!(
            impostor.requests().is_empty(),
            "no request reached the impostor"
        );
    }

    #[tokio::test]
    async fn a_certificate_naming_another_bridge_is_refused_for_a_bound_key() {
        let store = Arc::new(InMemoryStore::default());
        let bridge = TestBridge::presenting(&self_signed("001788fffe00ffff"), &[], answering_ok());

        let error = client(BridgeTrust::bridge(BRIDGE_A), &store)
            .get(url(&bridge))
            .header("hue-application-key", "secret")
            .send()
            .await
            .expect_err("the key's bridge is not the one answering");

        assert_eq!(
            identity_rejection(&error),
            Some(IdentityRejection::WrongBridge {
                expected: BRIDGE_A.to_string(),
                presented: "001788fffe00ffff".to_string()
            })
        );
        assert!(bridge.requests().is_empty(), "the key was never sent");
        assert_eq!(store.get(&pin_account("001788fffe00ffff")).unwrap(), None);
    }

    #[tokio::test]
    async fn a_chained_certificate_matching_the_bound_bridge_is_accepted() {
        // The Signify roots cannot sign test certificates; a chain to another
        // CA runs the same handshake and is pinned as a leaf, while the
        // Signify chain itself is proven on a real Bridge Pro certificate in
        // `bridge_identity`.
        let (ca, leaf) = ca_signed(BRIDGE_A);
        let bridge = TestBridge::presenting(&leaf, &[&ca], answering_ok());
        let store = Arc::new(InMemoryStore::default());

        let response = client(BridgeTrust::bridge(BRIDGE_A), &store)
            .get(url(&bridge))
            .send()
            .await
            .unwrap();

        assert_eq!(answering_bridge_id(&response).as_deref(), Some(BRIDGE_A));
    }

    #[tokio::test]
    async fn a_certificate_that_names_no_bridge_is_refused() {
        let bridge = TestBridge::presenting(&self_signed("test-bridge"), &[], answering_ok());
        let store = Arc::new(InMemoryStore::default());

        let error = client(BridgeTrust::any(), &store)
            .get(url(&bridge))
            .send()
            .await
            .unwrap_err();

        assert_eq!(
            identity_rejection(&error),
            Some(IdentityRejection::NotABridge)
        );
    }

    #[tokio::test]
    async fn a_redirect_is_returned_not_followed() {
        let bridge = TestBridge::presenting(&self_signed(BRIDGE_A), &[], |_, _, _| {
            Reply::text(302, String::new()).with_header("Location", "https://127.0.0.1:1/steal")
        });
        let store = Arc::new(InMemoryStore::default());

        let response = client(BridgeTrust::any(), &store)
            .get(url(&bridge))
            .header("hue-application-key", "secret")
            .send()
            .await
            .unwrap();

        assert_eq!(response.status().as_u16(), 302);
        assert_eq!(response.url().as_str(), url(&bridge));
        assert_eq!(bridge.requests().len(), 1);
    }

    #[tokio::test]
    async fn a_body_past_the_cap_is_refused() {
        let bridge = TestBridge::presenting(&self_signed(BRIDGE_A), &[], |_, _, _| {
            Reply::text(200, "x".repeat(HUE_MAX_RESPONSE_BYTES + 1))
        });
        let store = Arc::new(InMemoryStore::default());

        let response = client(BridgeTrust::any(), &store)
            .get(url(&bridge))
            .send()
            .await
            .unwrap();

        assert_eq!(read_body(response).await, Err(too_large()));
    }

    #[test]
    fn the_blocking_client_meets_the_same_verifier_and_cap() {
        let store = Arc::new(InMemoryStore::default());
        let first = TestBridge::presenting(&self_signed(BRIDGE_A), &[], |_, _, _| {
            Reply::text(200, "x".repeat(HUE_MAX_RESPONSE_BYTES + 1))
        });
        let impostor = TestBridge::presenting(&self_signed(BRIDGE_A), &[], answering_ok());
        let blocking =
            build_blocking_client(&BridgeTrust::any(), store.clone(), Duration::from_secs(5))
                .unwrap();

        let response = blocking.get(url(&first)).send().unwrap();
        assert_eq!(read_body_blocking(response), Err(too_large()));
        let error = blocking.get(url(&impostor)).send().unwrap_err();
        assert!(matches!(
            identity_rejection(&error),
            Some(IdentityRejection::CertificateChanged { .. })
        ));
    }

    /// Older firmware may stop at TLS 1.2, where the handshake signature goes
    /// through the other verifier entry point.
    #[test]
    fn a_tls12_bridge_completes_and_is_held_to_its_pin() {
        let store = Arc::new(InMemoryStore::default());
        let leaf = self_signed(BRIDGE_A);
        let first = TestBridge::presenting_tls12(&leaf, answering_ok());
        let impostor = TestBridge::presenting_tls12(&self_signed(BRIDGE_A), answering_ok());
        let blocking =
            build_blocking_client(&BridgeTrust::any(), store.clone(), Duration::from_secs(5))
                .unwrap();

        let response = blocking.get(url(&first)).send().unwrap();
        assert_eq!(read_body_blocking(response).unwrap(), ok_body());
        let error = blocking.get(url(&impostor)).send().unwrap_err();
        assert!(matches!(
            identity_rejection(&error),
            Some(IdentityRejection::CertificateChanged { .. })
        ));
    }

    #[test]
    fn plain_http_is_refused_by_every_bridge_client() {
        let store = Arc::new(InMemoryStore::default());
        let blocking =
            build_blocking_client(&BridgeTrust::any(), store, Duration::from_secs(1)).unwrap();
        let error = blocking
            .get("http://127.0.0.1:1/clip/v2/resource/bridge")
            .send()
            .unwrap_err();
        assert!(error.is_builder(), "{error}");
    }
}
