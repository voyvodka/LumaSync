//! Builds the Hue color sender: DTLS first, HTTP fallback on failure or when
//! no client key is available. Carved out of `sender.rs`.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};
use std::sync::Arc;
use std::time::Duration;

use log::{error, info, warn};

use super::super::dtls::DTLS_CONNECT_TIMEOUT_SECS;
use super::super::frame::{HueAreaChannel, HueColorSender};
use super::super::state_store::StartHueStreamRequest;
use super::super::transport::blocking_client_for_key;
use super::channels::HueLightMetadata;
use super::dtls_loop::spawn_hue_dtls_sender;
use super::entertainment::{
    deactivate_with_token, new_shutdown_signal, signal_shutdown_complete, DeactivateToken,
    ShutdownSignal,
};
use super::http_fallback::spawn_hue_http_sender;

// ---------------------------------------------------------------------------
// Sender builder: DTLS-with-HTTP-fallback orchestrator
// ---------------------------------------------------------------------------

/// No-op sender used when the HTTP client cannot be built. Centralised so we
/// avoid scattering the `tx`/`channel_count` initialiser across the failure
/// paths of `build_hue_sender`.
pub(crate) fn no_op_sender() -> HueColorSender {
    HueColorSender::with_mailbox(0).0
}

/// Shutdown signal for a sender that never spawned a thread. Pre-signalled,
/// because nothing else can fire it — a fresh signal here made every later
/// `stop_hue_stream` burn the full timeout and report `HUE_STOP_TIMEOUT_PARTIAL`
/// for a stream that was never running.
pub(crate) fn settled_shutdown_signal() -> ShutdownSignal {
    let signal = new_shutdown_signal();
    signal_shutdown_complete(&signal);
    signal
}

/// A sender that has been spawned but not yet stored into `HueRuntimeOwner`.
pub(crate) struct SpawnedHueSender {
    pub(crate) color_sender: HueColorSender,
    pub(crate) uses_dtls: bool,
    pub(crate) shutdown_signal: ShutdownSignal,
    pub(crate) cipher_name: Option<String>,
    /// Shared by the sender thread, foreground `stop_hue_stream`, and the
    /// reconnect monitor — the one-shot dedupe primitive for the deactivate PUT.
    pub(crate) deactivate_token: Arc<DeactivateToken>,
}

impl SpawnedHueSender {
    /// Stand-in for a sender that never started: nothing to stop, nothing to
    /// deactivate, and nothing to count.
    pub(crate) fn inert() -> Self {
        Self {
            color_sender: no_op_sender(),
            uses_dtls: false,
            shutdown_signal: settled_shutdown_signal(),
            cipher_name: None,
            deactivate_token: DeactivateToken::new(),
        }
    }
}

/// Spawn the Hue color sender (DTLS or HTTP fallback) **outside** any mutex
/// lock.  This function performs blocking network I/O (DTLS handshake, HTTP
/// activate) and must never be called while the `HueRuntimeOwner` lock is held.
///
/// `packet_counter` must be the owner's `packet_send_count` — telemetry reads
/// that one, so a counter of the caller's own reports 0 pkt/s forever.
pub(crate) fn build_hue_sender(
    request: &StartHueStreamRequest,
    channels: Vec<HueAreaChannel>,
    light_metadata: Arc<HashMap<String, HueLightMetadata>>,
    packet_counter: Arc<std::sync::atomic::AtomicU32>,
) -> SpawnedHueSender {
    // Keychain-first credential resolution. The request
    // values from the Tauri command are treated as a downgrade-safe
    // fallback for legacy v1.4 users whose credentials still live in
    // the plaintext shellStore fields. When the keychain holds both
    // halves we use those over the request values; this is the path
    // every v1.5+ user takes after the first successful pairing.
    //
    // No peer bridge id is passed: the pair's owner is enforced on the HTTPS
    // legs that precede DTLS (the forced readiness read and the activate PUT
    // below both go through a client bound to it), and comparing the address
    // instead is what stranded the pair after a DHCP renewal.
    let store = super::super::credential_store::default_store();
    let resolved = super::super::credential_store::resolve_hue_credentials(
        store.as_ref(),
        "",
        &request.username,
        &request.client_key,
    );
    // Halves from different pairings; only reachable via external keychain
    // tampering, so report and carry on rather than attempting recovery.
    if matches!(
        resolved.as_ref().map(|r| r.backend),
        Some(super::super::credential_store::CredentialBackend::PlaintextLegacy)
    ) && super::super::credential_store::resolve_hue_app_key(store.as_ref(), "").is_some()
    {
        warn!("[hue-cred] keychain holds an app key but the DTLS pair resolved from plaintext");
    }

    let (resolved_username, resolved_client_key) = match resolved {
        Some(r) => (r.username, r.client_key),
        None => (request.username.clone(), request.client_key.clone()),
    };
    let has_client_key = !resolved_client_key.trim().is_empty();

    // Single dedupe token shared by the sender thread, foreground stop, and
    // reconnect monitor. The HTTP fallback path also gets a token so call
    // sites have a uniform shape — fallback paths simply never need to
    // acquire it because there is no DTLS slot to release on the bridge.
    let deactivate_token = DeactivateToken::new();

    if has_client_key {
        match blocking_client_for_key(&resolved_username) {
            Ok(client) => {
                // Spawn DTLS attempt on a dedicated OS thread with a hard deadline.
                // DTLS handshake can block indefinitely if the bridge ignores UDP:2100 —
                // the socket-level read timeout is not honored by OpenSSL's retransmit loop.
                let (tx_result, rx_result) = std::sync::mpsc::channel();
                let client_clone = client.clone();
                let bridge_ip_t = request.bridge_ip.clone();
                let username_t = resolved_username.clone();
                let client_key_t = resolved_client_key.clone();
                let area_id_t = request.area_id.clone();
                let channels_t = channels.clone();
                let light_metadata_t = Arc::clone(&light_metadata);
                let counter_t = Arc::clone(&packet_counter);
                let token_t = Arc::clone(&deactivate_token);
                let abandoned = Arc::new(AtomicBool::new(false));
                let abandoned_t = Arc::clone(&abandoned);

                std::thread::spawn(move || {
                    let result = spawn_hue_dtls_sender(
                        client_clone,
                        bridge_ip_t,
                        username_t,
                        client_key_t,
                        area_id_t,
                        channels_t,
                        light_metadata_t,
                        counter_t,
                        token_t,
                        abandoned_t,
                    );
                    let _ = tx_result.send(result);
                });

                match rx_result.recv_timeout(Duration::from_secs(DTLS_CONNECT_TIMEOUT_SECS)) {
                    Ok(Ok((sender, shutdown, cipher_name))) => {
                        info!("DTLS entertainment stream established successfully.");
                        SpawnedHueSender {
                            color_sender: sender,
                            uses_dtls: true,
                            shutdown_signal: shutdown,
                            cipher_name,
                            deactivate_token,
                        }
                    }
                    Ok(Err(err)) => {
                        warn!("DTLS connection failed ({err}), falling back to HTTP.");
                        let (sender, shutdown) = spawn_hue_http_sender(
                            client,
                            request.bridge_ip.clone(),
                            resolved_username.clone(),
                            channels.clone(),
                        );
                        SpawnedHueSender {
                            color_sender: sender,
                            uses_dtls: false,
                            shutdown_signal: shutdown,
                            cipher_name: None,
                            deactivate_token,
                        }
                    }
                    Err(_timeout) => {
                        warn!(
                            "DTLS handshake timed out after {}s, falling back to HTTP.",
                            DTLS_CONNECT_TIMEOUT_SECS
                        );
                        // Flag first, then take the token: the handshake thread
                        // already ran `activate_...`, and winning the token is
                        // what stops it deactivating a later session's area.
                        abandoned.store(true, AtomicOrdering::Release);
                        if let Err(err) = deactivate_with_token(
                            &deactivate_token,
                            &client,
                            &request.bridge_ip,
                            &resolved_username,
                            &request.area_id,
                        ) {
                            warn!(
                                "Rollback deactivate after the abandoned DTLS handshake failed \
                                 ({err}) — bridge may hold active_streamer for area {}",
                                request.area_id
                            );
                        }
                        let (sender, shutdown) = spawn_hue_http_sender(
                            client,
                            request.bridge_ip.clone(),
                            resolved_username.clone(),
                            channels.clone(),
                        );
                        SpawnedHueSender {
                            color_sender: sender,
                            uses_dtls: false,
                            shutdown_signal: shutdown,
                            cipher_name: None,
                            deactivate_token,
                        }
                    }
                }
            }
            Err(err) => {
                error!("HUE_SENDER_INIT_FAILED: {err}");
                SpawnedHueSender {
                    deactivate_token,
                    ..SpawnedHueSender::inert()
                }
            }
        }
    } else {
        info!("No clientKey provided, using HTTP fallback sender.");
        match blocking_client_for_key(&resolved_username) {
            Ok(client) => {
                let (sender, shutdown) = spawn_hue_http_sender(
                    client,
                    request.bridge_ip.clone(),
                    resolved_username.clone(),
                    channels.clone(),
                );
                SpawnedHueSender {
                    color_sender: sender,
                    uses_dtls: false,
                    shutdown_signal: shutdown,
                    cipher_name: None,
                    deactivate_token,
                }
            }
            Err(err) => {
                error!("HUE_SENDER_INIT_FAILED: {err}");
                SpawnedHueSender {
                    deactivate_token,
                    ..SpawnedHueSender::inert()
                }
            }
        }
    }
}
