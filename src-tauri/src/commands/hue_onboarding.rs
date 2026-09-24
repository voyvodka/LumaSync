//! Hue bridge discovery, pairing, and Entertainment Area onboarding commands —
//! the read/pair path that runs before a stream can start.
//!
//! This file is the façade; the code lives in the submodules below and the
//! paths the rest of the crate uses are re-exported here.
//!
//! - `discovery` — cloud + mDNS bridge discovery, manual-IP verification
//! - `pairing` — link-button pairing, keychain credential migration,
//!   credential validation
//! - `readiness` — Entertainment Area listing and stream-readiness gating

// `#[path]` is explicit (not relying on the `hue_onboarding/` directory
// convention) because `tests/hue_onboarding_tdd.rs` mounts this very file at
// a different logical module path via its own `#[path]`; an implicit lookup
// would search relative to that mount point instead of this file's own
// directory, and fail to find these submodules there.
#[path = "hue_onboarding/discovery.rs"]
mod discovery;
#[path = "hue_onboarding/pairing.rs"]
mod pairing;
#[path = "hue_onboarding/readiness.rs"]
mod readiness;

// Production commands + DTOs: registered in lib.rs, or consumed by other
// production modules (health.rs, hue_driver.rs, commands.rs, reconnect.rs,
// area_cache.rs, sender/channels.rs). `#[allow(unused_imports)]`: the
// standalone `tests/hue_onboarding_tdd.rs` integration binary mounts this
// file alone via `#[path]` and never touches these — it only exercises the
// pure parsers below — so that one compilation sees every name here as dead.
#[allow(unused_imports)]
pub use discovery::{discover_hue_bridges, verify_hue_bridge_ip};
#[allow(unused_imports)]
pub use pairing::{
    migrate_hue_credentials, pair_hue_bridge, validate_hue_credentials,
    HueValidateCredentialsResponse,
};
#[allow(unused_imports)]
pub use readiness::{
    check_hue_stream_readiness, list_hue_entertainment_areas, HueEntertainmentArea,
    HueStreamReadiness, HueStreamReadinessResponse,
};
#[allow(unused_imports)]
pub(crate) use readiness::{
    check_hue_stream_readiness_with_freshness, ActiveStreamerView, AreaListError,
    ACTIVE_STREAMER_REASON,
};

// Test-only surface, reachable only through this facade because
// `discovery`/`pairing`/`readiness` are private modules.
//
// - `tests/hue_onboarding_tdd.rs` needs the five pure parsers below: it
//   mounts this file standalone via its own `#[path]` and never sees the
//   rest of the crate.
// - `hue/transport/onboarding_tests.rs`, a unit test that lives inside this
//   crate, needs the three network-facing halves instead.
//
// Neither consumer needs the other's half, so each `#[allow(unused_imports)]`
// covers exactly one of `cargo test`'s two test binaries for this crate.
#[cfg(test)]
#[allow(unused_imports)]
pub(crate) use discovery::verify_bridge_at;
#[cfg(test)]
#[allow(unused_imports)]
pub use discovery::{parse_discovery_payload, verify_hue_bridge_ip_input};
#[cfg(test)]
#[allow(unused_imports)]
pub(crate) use pairing::{pair_bridge_at, validate_app_key_at};
#[cfg(test)]
#[allow(unused_imports)]
pub use pairing::{parse_bridge_resource_payload, parse_pairing_payload};
#[cfg(test)]
#[allow(unused_imports)]
pub use readiness::parse_area_list_payload;

/// `details` for the "nothing resolved" arms. The reused
/// `AUTH_INVALID_RE_PAIR_REQUIRED` message asserts the bridge returned a 403,
/// which is not what happened here — the distinction lives in `details` rather
/// than in a new code, because a new code would fall through every shipped
/// `switch` into the default branch and render the wrong card.
const NO_APP_KEY_DETAILS: &str =
    "No Hue application key in the OS keychain or the request payload.";

use log::info;
use reqwest::Client;

use super::hue::transport::is_tls_failure;
use super::status::CommandStatus;

/// The address answered with a certificate that is not the bridge's we expect
/// (or not a bridge's at all). Nothing carrying a secret was sent.
fn identity_mismatch_status(details: String) -> CommandStatus {
    command_status(
        "HUE_BRIDGE_IDENTITY_MISMATCH",
        "The device at this address is not the Hue bridge LumaSync paired with, or its certificate changed.",
        Some(details),
    )
}

/// Send a CLIP v1 request to the bridge, preferring HTTPS and falling back to
/// plain HTTP.
///
/// Hue Bridge Pro (2025) serves the local API on HTTPS/443 only — port 80 is
/// closed, so the legacy `http://<ip>/api` calls fail at the transport layer
/// and surface as a bogus `HUE_PAIRING_FAILED` (issue #167). Square v2 bridges
/// answer on both ports, so HTTPS-first is safe for every generation; the HTTP
/// retry only exists for older firmware whose TLS stack we cannot reach.
///
/// The fallback triggers on transport errors only, and never on a failed TLS
/// handshake (a refused certificate included): reqwest reports those as
/// connect errors too, and that failure is exactly what a downgrade attacker
/// manufactures. Once a bridge answers with any HTTP status the response is
/// returned untouched so `classify_hue_response` keeps owning the
/// 403/`error.type` re-pair contract.
///
/// `http_fallback` must stay `None` on the pairing call — it returns the
/// DTLS `clientkey`. See docs/architecture/hue.md (downgrade-attack constraint).
pub(crate) async fn send_clip_v1<F>(
    client: &Client,
    bridge_ip: &str,
    path: &str,
    http_fallback: Option<&Client>,
    build: F,
) -> Result<reqwest::Response, reqwest::Error>
where
    F: Fn(&Client, String) -> reqwest::RequestBuilder,
{
    let https_error = match build(client, format!("https://{bridge_ip}{path}"))
        .send()
        .await
    {
        Ok(response) => return Ok(response),
        Err(error) => error,
    };

    let Some(http_client) = http_fallback else {
        return Err(https_error);
    };
    if !https_error.is_connect() || is_tls_failure(&https_error) {
        return Err(https_error);
    }

    match build(http_client, format!("http://{bridge_ip}{path}"))
        .send()
        .await
    {
        Ok(response) => {
            info!("Hue bridge {bridge_ip} answered on plain HTTP after HTTPS failed");
            Ok(response)
        }
        // Surface the HTTPS failure: on a Bridge Pro that is the actionable one.
        Err(_) => Err(https_error),
    }
}

fn command_status(code: &str, message: &str, details: Option<String>) -> CommandStatus {
    CommandStatus {
        code: code.to_string(),
        message: message.to_string(),
        details,
    }
}

#[cfg(test)]
#[path = "hue_onboarding/discovery_tests.rs"]
mod discovery_tests;

#[cfg(test)]
#[path = "hue_onboarding/pairing_tests.rs"]
mod pairing_tests;

#[cfg(test)]
#[path = "hue_onboarding/readiness_tests.rs"]
mod readiness_tests;
