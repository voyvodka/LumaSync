//! Shared HTTP classification helpers for Hue CLIP v2 responses.
//!
//! Centralises the **sole re-pair trigger** contract described in
//! `ls-hue-protocol §2.4`: only an HTTP 403 whose body is Hue-shaped
//! **and** carries `error.type == 1` (unauthorized user) is allowed to
//! map onto `HueHttpFault::AuthInvalid` — which is the single signal the
//! frontend uses to flip `AUTH_INVALID_RE_PAIR_REQUIRED` and offer a
//! "re-pair bridge" recovery action.
//!
//! Every other 403 shape (CLIP error `type == 7` invalid value, non-Hue
//! bodies from reverse proxies / captive portals, empty bodies, etc.)
//! maps to `HueHttpFault::Transient` so we never ask the user to re-pair
//! on a bogus signal.
//!
//! The helpers live here (not inside `hue_onboarding.rs` or
//! `hue_stream_lifecycle.rs`) so the G8 split of
//! `hue_stream_lifecycle.rs` (v1.5, P3) can lift them without touching
//! the contract surface.

use serde_json::Value;

/// Classification outcome for a non-success Hue HTTP response.
///
/// `AuthInvalid` is the **only** variant the caller is allowed to turn
/// into a re-pair signal. Any other variant must surface as a transient
/// recovery (retry / reconnect) and must **never** escalate to re-pair.
#[derive(Debug)]
pub(crate) enum HueHttpFault {
    /// 403 + Hue-shaped body + `error.type == 1`. Sole re-pair trigger.
    AuthInvalid,
    /// Any other non-success status (403 with non-unauthorized body,
    /// 4xx except 404, 5xx without a server-error flag, etc.) where the
    /// caller should retry rather than re-pair.
    Transient { status: u16, body: String },
    /// 404 Not Found. Kept distinct so callers can surface "resource
    /// removed" (e.g. entertainment area deleted bridge-side) without a
    /// retry loop.
    NotFound,
    /// 5xx server error. Kept distinct so callers can apply the
    /// `HueRetryPolicy` exponential backoff policy specifically to this
    /// class.
    #[allow(dead_code)]
    ServerError { status: u16 },
}

impl std::fmt::Display for HueHttpFault {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            HueHttpFault::AuthInvalid => write!(f, "AUTH_INVALID_RE_PAIR_REQUIRED"),
            HueHttpFault::Transient { status, body } => {
                write!(f, "HUE_TRANSIENT: HTTP {status} — {body}")
            }
            HueHttpFault::NotFound => write!(f, "HUE_NOT_FOUND"),
            HueHttpFault::ServerError { status } => {
                write!(f, "HUE_SERVER_ERROR: HTTP {status}")
            }
        }
    }
}

/// Returns `true` iff `body` looks like the classic Hue CLIP v1/v2
/// unauthorized envelope:
///
/// ```json
/// [{ "error": { "type": 1, "address": "/...", "description": "unauthorized user" } }]
/// ```
///
/// **Whitelist semantics — DNA critical:** only `error.type == 1` is
/// treated as unauthorized. `type == 7` (invalid value) and every other
/// Hue CLIP error code must **not** trigger re-pair; they are surfaced
/// as transient so the user is never nudged into an unnecessary
/// re-pairing ceremony.
///
/// A non-array, non-Hue body (HTML, reverse-proxy error page, empty
/// string, …) returns `false` so reverse-proxy 403s never escalate.
pub(crate) fn is_hue_unauthorized_body(body: &str) -> bool {
    let Ok(value) = serde_json::from_str::<Value>(body) else {
        return false;
    };

    value
        .as_array()
        .and_then(|items| items.first())
        .and_then(|entry| entry.get("error"))
        .and_then(|error| error.get("type"))
        .and_then(|kind| kind.as_i64())
        .is_some_and(|kind| kind == 1)
}

/// Classify a Hue async HTTP response.
///
/// On success (2xx) returns the response untouched so the caller can
/// keep chaining `.text().await`. On any non-success status the body is
/// drained and inspected against the whitelist to decide if the call
/// site is allowed to escalate to `AuthInvalid`.
pub(crate) async fn classify_hue_response(
    response: reqwest::Response,
) -> Result<reqwest::Response, HueHttpFault> {
    let status = response.status();
    if status.is_success() {
        return Ok(response);
    }

    let status_code = status.as_u16();
    // Body drain must succeed-or-fail-closed: if we cannot read the body
    // we cannot prove unauthorized, so fall through to `Transient`.
    let body = response.text().await.unwrap_or_default();
    Err(classify_status(status_code, &body))
}

/// Blocking variant used by `hue_stream_lifecycle.rs` (the HTTP-fallback
/// PUT path). Same semantics as [`classify_hue_response`], duplicated
/// only because `reqwest::blocking::Response` and `reqwest::Response`
/// do not share a trait object surface.
pub(crate) fn classify_hue_response_blocking(
    response: reqwest::blocking::Response,
) -> Result<reqwest::blocking::Response, HueHttpFault> {
    let status = response.status();
    if status.is_success() {
        return Ok(response);
    }

    let status_code = status.as_u16();
    let body = response.text().unwrap_or_default();
    Err(classify_status(status_code, &body))
}

/// Pure status→fault mapping shared between async and blocking call
/// sites. Kept free of I/O so it is trivially testable.
fn classify_status(status: u16, body: &str) -> HueHttpFault {
    match status {
        403 if is_hue_unauthorized_body(body) => HueHttpFault::AuthInvalid,
        404 => HueHttpFault::NotFound,
        500..=599 => HueHttpFault::ServerError { status },
        _ => HueHttpFault::Transient {
            status,
            body: body.to_string(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn type_1_body_is_unauthorized() {
        let body = r#"[{"error":{"type":1,"address":"/","description":"unauthorized user"}}]"#;
        assert!(is_hue_unauthorized_body(body));
    }

    #[test]
    fn type_7_body_is_not_unauthorized() {
        let body = r#"[{"error":{"type":7,"address":"/lights/1","description":"invalid value"}}]"#;
        assert!(!is_hue_unauthorized_body(body));
    }

    #[test]
    fn non_hue_body_is_not_unauthorized() {
        assert!(!is_hue_unauthorized_body("<html>403 Forbidden</html>"));
        assert!(!is_hue_unauthorized_body(""));
        assert!(!is_hue_unauthorized_body("{\"unrelated\":true}"));
    }

    #[test]
    fn classify_status_maps_403_type_1_to_auth_invalid() {
        let body = r#"[{"error":{"type":1,"description":"unauthorized user"}}]"#;
        assert!(matches!(
            classify_status(403, body),
            HueHttpFault::AuthInvalid
        ));
    }

    #[test]
    fn classify_status_maps_403_type_7_to_transient() {
        let body = r#"[{"error":{"type":7,"description":"invalid value"}}]"#;
        match classify_status(403, body) {
            HueHttpFault::Transient { status, .. } => assert_eq!(status, 403),
            other => panic!("expected Transient, got {other:?}"),
        }
    }

    #[test]
    fn classify_status_maps_403_non_hue_body_to_transient() {
        match classify_status(403, "<html>proxy denied</html>") {
            HueHttpFault::Transient { status, .. } => assert_eq!(status, 403),
            other => panic!("expected Transient, got {other:?}"),
        }
    }

    #[test]
    fn classify_status_maps_404_to_not_found() {
        assert!(matches!(classify_status(404, ""), HueHttpFault::NotFound));
    }

    #[test]
    fn classify_status_maps_500_to_server_error() {
        match classify_status(503, "") {
            HueHttpFault::ServerError { status } => assert_eq!(status, 503),
            other => panic!("expected ServerError, got {other:?}"),
        }
    }
}
