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
    /// 429 Too Many Requests. Distinct from `Transient` because the
    /// correct response is not "retry" but "send *less*": the bridge is
    /// telling us we exceeded its command budget. Callers that pace
    /// requests must widen their interval on this variant, otherwise a
    /// throttling bridge can never slow the client down. `retry_after_ms`
    /// carries the `Retry-After` header when the bridge supplies one.
    RateLimited {
        status: u16,
        retry_after_ms: Option<u64>,
    },
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
            HueHttpFault::RateLimited { status, .. } => {
                write!(f, "HUE_RATE_LIMITED: HTTP {status}")
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

    let v1_unauthorized = value
        .as_array()
        .and_then(|items| items.first())
        .and_then(|entry| entry.get("error"))
        .and_then(|error| error.get("type"))
        .and_then(|kind| kind.as_i64())
        .is_some_and(|kind| kind == 1);

    v1_unauthorized || is_clip_v2_unauthorized(&value)
}

/// CLIP v2 replaced the v1 array envelope with
/// `{"errors":[{"description":"..."}]}` and dropped the numeric `type`, so the
/// v1 whitelist above can never match a v2 body — which left every `/clip/v2/*`
/// caller unable to reach `AuthInvalid` and reporting a revoked key as a
/// retryable transient fault.
///
/// The description string is the only auth signal v2 gives us, so the match
/// stays narrow: a body must be Hue-shaped (`errors` array of objects) AND say
/// it is an authentication problem. Anything else stays `Transient`, preserving
/// the "never nudge the user into an unnecessary re-pair" rule.
fn is_clip_v2_unauthorized(value: &Value) -> bool {
    value
        .get("errors")
        .and_then(|errors| errors.as_array())
        .and_then(|items| items.first())
        .and_then(|entry| entry.get("description"))
        .and_then(|description| description.as_str())
        .is_some_and(|description| {
            let lowered = description.to_lowercase();
            lowered.contains("unauthorized")
                || lowered.contains("authenticat")
                || lowered.contains("application key")
        })
}

impl HueHttpFault {
    /// Attach a `Retry-After` hint parsed from the response headers. A
    /// no-op for every variant except `RateLimited`, so the pure
    /// [`classify_status`] mapping stays header-blind and trivially
    /// testable while the I/O wrappers still surface the hint.
    fn with_retry_after(self, retry_after_ms: Option<u64>) -> Self {
        match self {
            HueHttpFault::RateLimited { status, .. } => HueHttpFault::RateLimited {
                status,
                retry_after_ms,
            },
            other => other,
        }
    }

    /// Does this fault mean "you are sending too much"? `429` is the
    /// explicit signal; `503` (and the rest of 5xx) is the Hue bridge's
    /// usual reply when its ZigBee queue is saturated, which is the same
    /// instruction wearing a different status code. Paced callers must
    /// widen their request interval on `Some(_)`; the payload is the
    /// bridge-supplied `Retry-After`, when it sent one.
    pub(crate) fn throttle_hint(&self) -> Option<Option<u64>> {
        match self {
            HueHttpFault::RateLimited { retry_after_ms, .. } => Some(*retry_after_ms),
            HueHttpFault::ServerError { .. } => Some(None),
            _ => None,
        }
    }
}

/// Parse the `Retry-After` header into milliseconds. Only the delta-seconds
/// form is honoured — the HTTP-date form is legal but the Hue bridge does not
/// emit it, and guessing wrong here would stall the sender for hours.
fn parse_retry_after_ms(headers: &reqwest::header::HeaderMap) -> Option<u64> {
    headers
        .get(reqwest::header::RETRY_AFTER)?
        .to_str()
        .ok()?
        .trim()
        .parse::<u64>()
        .ok()
        .map(|seconds| seconds.saturating_mul(1_000))
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
    let retry_after_ms = parse_retry_after_ms(response.headers());
    // Body drain must succeed-or-fail-closed: if we cannot read the body
    // we cannot prove unauthorized, so fall through to `Transient`.
    let body = response.text().await.unwrap_or_default();
    Err(classify_status(status_code, &body).with_retry_after(retry_after_ms))
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
    let retry_after_ms = parse_retry_after_ms(response.headers());
    let body = response.text().unwrap_or_default();
    Err(classify_status(status_code, &body).with_retry_after(retry_after_ms))
}

/// Pure status→fault mapping shared between async and blocking call
/// sites. Kept free of I/O so it is trivially testable.
fn classify_status(status: u16, body: &str) -> HueHttpFault {
    match status {
        // CLIP v2 documents 401 alongside 403 for a rejected application key;
        // v1 only ever used 403. Both still require a Hue-shaped auth body.
        401 | 403 if is_hue_unauthorized_body(body) => HueHttpFault::AuthInvalid,
        404 => HueHttpFault::NotFound,
        // Rate limiting is its own class: it is the bridge asking for a
        // *wider* interval, which a plain retry would not deliver.
        429 => HueHttpFault::RateLimited {
            status,
            retry_after_ms: None,
        },
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
    fn clip_v2_unauthorized_body_is_recognised() {
        let body = r#"{"errors":[{"description":"Requested resource is unauthorized"}]}"#;
        assert!(is_hue_unauthorized_body(body));
    }

    #[test]
    fn clip_v2_non_auth_error_is_not_unauthorized() {
        let body = r#"{"errors":[{"description":"resource not available"}]}"#;
        assert!(!is_hue_unauthorized_body(body));
    }

    #[test]
    fn classify_status_maps_401_clip_v2_to_auth_invalid() {
        let body = r#"{"errors":[{"description":"unauthorized user"}]}"#;
        assert!(matches!(
            classify_status(401, body),
            HueHttpFault::AuthInvalid
        ));
    }

    #[test]
    fn classify_status_maps_401_non_hue_body_to_transient() {
        match classify_status(401, "<html>proxy auth required</html>") {
            HueHttpFault::Transient { status, .. } => assert_eq!(status, 401),
            other => panic!("expected Transient, got {other:?}"),
        }
    }

    #[test]
    fn classify_status_maps_404_to_not_found() {
        assert!(matches!(classify_status(404, ""), HueHttpFault::NotFound));
    }

    #[test]
    fn classify_status_maps_429_to_rate_limited() {
        match classify_status(429, r#"{"errors":[{"description":"rate limit"}]}"#) {
            HueHttpFault::RateLimited {
                status,
                retry_after_ms,
            } => {
                assert_eq!(status, 429);
                assert_eq!(
                    retry_after_ms, None,
                    "header hint is attached by the wrapper"
                );
            }
            other => panic!("expected RateLimited, got {other:?}"),
        }
    }

    #[test]
    fn rate_limited_and_server_error_are_throttle_signals() {
        assert_eq!(classify_status(429, "").throttle_hint(), Some(None));
        assert_eq!(classify_status(503, "").throttle_hint(), Some(None));
        // A 429 is a throttle instruction, never a re-pair one.
        assert!(!matches!(
            classify_status(429, r#"[{"error":{"type":1}}]"#),
            HueHttpFault::AuthInvalid
        ));
        // Everything else must leave a paced sender's interval alone.
        assert_eq!(classify_status(400, "").throttle_hint(), None);
        assert_eq!(classify_status(404, "").throttle_hint(), None);
        assert_eq!(HueHttpFault::AuthInvalid.throttle_hint(), None);
    }

    #[test]
    fn with_retry_after_only_enriches_the_rate_limited_variant() {
        match classify_status(429, "").with_retry_after(Some(2_000)) {
            HueHttpFault::RateLimited { retry_after_ms, .. } => {
                assert_eq!(retry_after_ms, Some(2_000));
            }
            other => panic!("expected RateLimited, got {other:?}"),
        }
        assert!(matches!(
            classify_status(404, "").with_retry_after(Some(2_000)),
            HueHttpFault::NotFound
        ));
    }

    #[test]
    fn parse_retry_after_ms_reads_delta_seconds_and_ignores_http_dates() {
        let mut headers = reqwest::header::HeaderMap::new();
        assert_eq!(parse_retry_after_ms(&headers), None);

        headers.insert(reqwest::header::RETRY_AFTER, "3".parse().unwrap());
        assert_eq!(parse_retry_after_ms(&headers), Some(3_000));

        headers.insert(
            reqwest::header::RETRY_AFTER,
            "Wed, 21 Oct 2015 07:28:00 GMT".parse().unwrap(),
        );
        assert_eq!(parse_retry_after_ms(&headers), None);
    }

    #[test]
    fn classify_status_maps_500_to_server_error() {
        match classify_status(503, "") {
            HueHttpFault::ServerError { status } => assert_eq!(status, 503),
            other => panic!("expected ServerError, got {other:?}"),
        }
    }
}
