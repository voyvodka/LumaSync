//! Shared HTTP classification helpers for Hue CLIP v2 responses.
//!
//! Centralises the **sole re-pair trigger** contract: only an HTTP 401/403
//! that is provably the bridge refusing our key maps onto
//! `HueHttpFault::AuthInvalid` — the single signal the frontend uses to flip
//! `AUTH_INVALID_RE_PAIR_REQUIRED` and offer a "re-pair bridge" action. Three
//! shapes qualify: the v1 `error.type == 1` envelope, a CLIP v2 `errors[]`
//! description about authentication, and the bridge's own HTML error page
//! (see `is_bridge_auth_page`).
//!
//! Every other 401/403 shape (CLIP error `type == 7` invalid value, non-Hue
//! bodies from reverse proxies / captive portals, empty bodies, etc.)
//! maps to `HueHttpFault::Transient` so we never ask the user to re-pair
//! on a bogus signal.
//!
//! The helpers live here rather than inside `hue_onboarding.rs` or the
//! streaming code so the v1.5 G8 split could lift them without touching the
//! contract surface. That split has since landed as `commands::hue::*`.

use serde_json::Value;

/// Classification outcome for a non-success Hue HTTP response.
///
/// `AuthInvalid` is the **only** variant the caller is allowed to turn
/// into a re-pair signal. Any other variant must surface as a transient
/// recovery (retry / reconnect) and must **never** escalate to re-pair.
#[derive(Debug)]
pub(crate) enum HueHttpFault {
    /// 401/403 that is provably the bridge refusing the key. Sole re-pair trigger.
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

/// Title of the HTML page a Hue bridge serves instead of JSON when CLIP v2 is
/// called with an unknown or missing `hue-application-key`.
const BRIDGE_ERROR_PAGE_TITLE: &str = "hue personal wireless lighting";

/// The real page is well under 1 KB. The cap keeps an arbitrary large HTML
/// document from being scanned; one that size is not that page.
const BRIDGE_ERROR_PAGE_MAX_BYTES: usize = 4_096;

/// Where a response came from, as far as the classifier can tell without
/// knowing which request produced it.
#[derive(Debug, Default, Clone)]
pub(crate) struct ResponseOrigin {
    content_type: Option<String>,
    /// The final URL — after any redirect reqwest followed — still addresses
    /// an IPv4 literal on a bridge API path. Every bridge call is made to
    /// `https://{bridge_ip}/api…` or `/clip/v2/…`; a captive portal answers by
    /// redirecting to its own login page, which fails this.
    from_bridge_address: bool,
}

impl ResponseOrigin {
    fn of(url: &reqwest::Url, headers: &reqwest::header::HeaderMap) -> Self {
        let content_type = headers
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        let host_is_ipv4 = url
            .host_str()
            .is_some_and(|host| host.parse::<std::net::Ipv4Addr>().is_ok());
        let path = url.path();
        let bridge_path =
            path.starts_with("/clip/v2/") || path == "/api" || path.starts_with("/api/");
        Self {
            content_type,
            from_bridge_address: host_is_ipv4 && bridge_path,
        }
    }
}

/// The bridge's own refusal of an application key, which is **not** JSON.
///
/// Observed on a BSB002 (fw 1978293000, API 1.78.0): CLIP v2 with an unknown
/// or missing `hue-application-key` answers `403`, `Content-Type: text/html`,
/// with a short page titled "hue personal wireless lighting". The JSON-only
/// rule could never match it, so a revoked key read as a transient fault.
///
/// Accepting HTML re-opens the door the Hue-shaped-body rule closed, so every
/// term is required: an HTML content type, the bridge's exact `<title>`, a
/// body the size of that page, and an origin that is still the bridge address
/// on an API path. See docs/architecture/hue.md for why that is enough.
fn is_bridge_auth_page(origin: &ResponseOrigin, body: &str) -> bool {
    if !origin.from_bridge_address || body.len() > BRIDGE_ERROR_PAGE_MAX_BYTES {
        return false;
    }
    let is_html = origin.content_type.as_deref().is_some_and(|ct| {
        ct.trim_start()
            .to_ascii_lowercase()
            .starts_with("text/html")
    });
    if !is_html {
        return false;
    }
    let lowered = body.to_ascii_lowercase();
    let Some(start) = lowered.find("<title>") else {
        return false;
    };
    let rest = &lowered[start + "<title>".len()..];
    rest.find("</title>")
        .is_some_and(|end| rest[..end].trim() == BRIDGE_ERROR_PAGE_TITLE)
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
    let origin = ResponseOrigin::of(response.url(), response.headers());
    // Body drain must succeed-or-fail-closed: if we cannot read the body
    // we cannot prove unauthorized, so fall through to `Transient`.
    let body = response.text().await.unwrap_or_default();
    Err(classify_status(status_code, &body, &origin).with_retry_after(retry_after_ms))
}

/// Blocking variant used by `hue::sender` (the HTTP-fallback PUT path).
/// Same semantics as [`classify_hue_response`], duplicated only because
/// `reqwest::blocking::Response` and `reqwest::Response` do not share a
/// trait object surface.
pub(crate) fn classify_hue_response_blocking(
    response: reqwest::blocking::Response,
) -> Result<reqwest::blocking::Response, HueHttpFault> {
    let status = response.status();
    if status.is_success() {
        return Ok(response);
    }

    let status_code = status.as_u16();
    let retry_after_ms = parse_retry_after_ms(response.headers());
    let origin = ResponseOrigin::of(response.url(), response.headers());
    let body = response.text().unwrap_or_default();
    Err(classify_status(status_code, &body, &origin).with_retry_after(retry_after_ms))
}

/// Pure status→fault mapping shared between async and blocking call
/// sites. Kept free of I/O so it is trivially testable.
fn classify_status(status: u16, body: &str, origin: &ResponseOrigin) -> HueHttpFault {
    match status {
        // CLIP v2 documents 401 alongside 403 for a rejected application key;
        // v1 only ever used 403. Both still require a body that is the bridge's.
        401 | 403 if is_hue_unauthorized_body(body) || is_bridge_auth_page(origin, body) => {
            HueHttpFault::AuthInvalid
        }
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
pub(crate) mod tests {
    use super::*;

    /// JSON-path tests: no content type and no bridge origin, so only the
    /// Hue-shaped JSON rule can promote.
    fn classify(status: u16, body: &str) -> HueHttpFault {
        classify_status(status, body, &ResponseOrigin::default())
    }

    /// Shape of what a BSB002 (fw 1978293000) served on 2026-09-23 for CLIP v2
    /// with a bogus `hue-application-key`: `text/html`, doctype, this title
    /// and this message. Reconstructed — the markup around them is not
    /// byte-for-byte the captured 432-byte page.
    pub(crate) const BRIDGE_403_PAGE: &str = "<!DOCTYPE HTML PUBLIC \"-//W3C//DTD HTML 4.01//EN\" \"http://www.w3.org/TR/html4/strict.dtd\">\n<html>\n<head>\n<meta http-equiv=\"Content-Type\" content=\"text/html; charset=utf-8\">\n<title>hue personal wireless lighting</title>\n<link rel=\"stylesheet\" type=\"text/css\" href=\"/index.css\">\n</head>\n<body>\n<div class=\"header\"><img src=\"/hue-logo.png\" class=\"hue-logo\"></div>\n<div class=\"error\">Oops, there appears to be no lighting here</div>\n</body>\n</html>\n";

    fn origin(url: &str, content_type: Option<&str>) -> ResponseOrigin {
        let mut headers = reqwest::header::HeaderMap::new();
        if let Some(ct) = content_type {
            headers.insert(reqwest::header::CONTENT_TYPE, ct.parse().unwrap());
        }
        ResponseOrigin::of(&reqwest::Url::parse(url).unwrap(), &headers)
    }

    const BRIDGE_V2_URL: &str =
        "https://192.168.1.180/clip/v2/resource/entertainment_configuration";

    #[test]
    fn the_bridges_html_403_is_a_re_pair() {
        let bridge = origin(BRIDGE_V2_URL, Some("text/html"));
        assert!(matches!(
            classify_status(403, BRIDGE_403_PAGE, &bridge),
            HueHttpFault::AuthInvalid
        ));
        assert!(matches!(
            classify_status(401, BRIDGE_403_PAGE, &bridge),
            HueHttpFault::AuthInvalid
        ));
        let with_charset = origin(BRIDGE_V2_URL, Some("Text/HTML; charset=utf-8"));
        assert!(matches!(
            classify_status(403, BRIDGE_403_PAGE, &with_charset),
            HueHttpFault::AuthInvalid
        ));
    }

    #[test]
    fn the_bridge_page_only_counts_on_401_or_403() {
        let bridge = origin(BRIDGE_V2_URL, Some("text/html"));
        assert!(matches!(
            classify_status(404, BRIDGE_403_PAGE, &bridge),
            HueHttpFault::NotFound
        ));
        assert!(matches!(
            classify_status(400, BRIDGE_403_PAGE, &bridge),
            HueHttpFault::Transient { status: 400, .. }
        ));
    }

    #[test]
    fn a_captive_portal_403_is_not_a_re_pair() {
        let bridge = origin(BRIDGE_V2_URL, Some("text/html"));
        let portal = "<!DOCTYPE html><html><head><title>Hotel Wi-Fi login</title></head><body>Please sign in</body></html>";
        assert!(matches!(
            classify_status(403, portal, &bridge),
            HueHttpFault::Transient { status: 403, .. }
        ));
        // A page that merely mentions Hue somewhere is still not the bridge's.
        let mention = "<html><head><title>Access denied</title></head><body>hue personal wireless lighting</body></html>";
        assert!(matches!(
            classify_status(403, mention, &bridge),
            HueHttpFault::Transient { .. }
        ));
    }

    #[test]
    fn the_bridge_page_needs_every_term_of_the_signature() {
        // Not HTML.
        for ct in [None, Some("application/json"), Some("text/plain")] {
            assert!(
                matches!(
                    classify_status(403, BRIDGE_403_PAGE, &origin(BRIDGE_V2_URL, ct)),
                    HueHttpFault::Transient { .. }
                ),
                "content type {ct:?} must not promote"
            );
        }
        // Redirected off the bridge address or off an API path.
        for url in [
            "http://portal.example/login",
            "http://10.0.0.1/login",
            "https://192.168.1.180/",
        ] {
            assert!(
                matches!(
                    classify_status(403, BRIDGE_403_PAGE, &origin(url, Some("text/html"))),
                    HueHttpFault::Transient { .. }
                ),
                "{url} must not promote"
            );
        }
        // The title padded into a document far larger than the bridge's page.
        let padded = format!(
            "{BRIDGE_403_PAGE}{}",
            " ".repeat(BRIDGE_ERROR_PAGE_MAX_BYTES)
        );
        assert!(matches!(
            classify_status(403, &padded, &origin(BRIDGE_V2_URL, Some("text/html"))),
            HueHttpFault::Transient { .. }
        ));
    }

    /// Local stand-in for the bridge: answers each connection with the next
    /// raw HTTP response, built once the port is known.
    fn serve(replies: impl FnOnce(u16) -> Vec<String>) -> (u16, std::thread::JoinHandle<()>) {
        use std::io::{BufRead, BufReader, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let replies = replies(port);
        let handle = std::thread::spawn(move || {
            for reply in replies {
                let (mut stream, _) = listener.accept().unwrap();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap() == 0 || line == "\r\n" {
                        break;
                    }
                }
                stream.write_all(reply.as_bytes()).unwrap();
            }
        });
        (port, handle)
    }

    fn raw(status: &str, content_type: &str, extra: &str, body: &str) -> String {
        format!(
            "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\n{extra}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
    }

    const V2_PATH: &str = "/clip/v2/resource/entertainment_configuration";

    #[tokio::test]
    async fn the_async_classifier_reads_the_bridges_html_403_off_the_wire() {
        let (port, server) =
            serve(|_| vec![raw("403 Forbidden", "text/html", "", BRIDGE_403_PAGE)]);
        let response = reqwest::Client::new()
            .get(format!("http://127.0.0.1:{port}{V2_PATH}"))
            .header("hue-application-key", "bogus")
            .send()
            .await
            .unwrap();
        let fault = classify_hue_response(response).await.unwrap_err();
        server.join().unwrap();
        assert!(matches!(fault, HueHttpFault::AuthInvalid), "{fault:?}");
    }

    #[test]
    fn the_blocking_classifier_reads_the_bridges_html_403_off_the_wire() {
        let (port, server) =
            serve(|_| vec![raw("403 Forbidden", "text/html", "", BRIDGE_403_PAGE)]);
        let response = reqwest::blocking::Client::new()
            .put(format!("http://127.0.0.1:{port}{V2_PATH}/area-1"))
            .header("hue-application-key", "bogus")
            .send()
            .unwrap();
        let fault = classify_hue_response_blocking(response).unwrap_err();
        server.join().unwrap();
        assert!(matches!(fault, HueHttpFault::AuthInvalid), "{fault:?}");
    }

    /// A portal that redirects the bridge URL to its own login page — even one
    /// that copies the bridge's page — is not the bridge refusing our key.
    #[tokio::test]
    async fn a_redirect_off_the_bridge_address_never_promotes() {
        let (port, server) = serve(|port| {
            vec![
                raw(
                    "302 Found",
                    "text/html",
                    &format!("Location: http://localhost:{port}/login\r\n"),
                    "",
                ),
                raw("403 Forbidden", "text/html", "", BRIDGE_403_PAGE),
            ]
        });
        let response = reqwest::Client::new()
            .get(format!("http://127.0.0.1:{port}{V2_PATH}"))
            .send()
            .await
            .unwrap();
        let fault = classify_hue_response(response).await.unwrap_err();
        server.join().unwrap();
        assert!(
            matches!(fault, HueHttpFault::Transient { status: 403, .. }),
            "{fault:?}"
        );
    }

    #[test]
    fn v1_api_paths_count_as_the_bridge() {
        assert!(origin("https://192.168.1.180/api/key/config", None).from_bridge_address);
        assert!(origin("http://192.168.1.180/api", None).from_bridge_address);
        assert!(!origin("https://192.168.1.180/apifoo", None).from_bridge_address);
        assert!(!origin("https://bridge.local/clip/v2/resource", None).from_bridge_address);
    }

    #[test]
    fn a_json_403_still_needs_a_hue_shaped_body_on_the_bridge_origin() {
        // The JSON rule is unchanged: newer firmware documented to answer
        // `{"errors":[{"description":"unauthorized user"}]}` keeps promoting,
        // and a JSON 403 that says something else keeps not promoting.
        let json = origin(BRIDGE_V2_URL, Some("application/json"));
        assert!(matches!(
            classify_status(
                403,
                r#"{"errors":[{"description":"unauthorized user"}]}"#,
                &json
            ),
            HueHttpFault::AuthInvalid
        ));
        assert!(matches!(
            classify_status(403, r#"{"errors":[{"description":"forbidden"}]}"#, &json),
            HueHttpFault::Transient { .. }
        ));
    }

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
        assert!(matches!(classify(403, body), HueHttpFault::AuthInvalid));
    }

    #[test]
    fn classify_status_maps_403_type_7_to_transient() {
        let body = r#"[{"error":{"type":7,"description":"invalid value"}}]"#;
        match classify(403, body) {
            HueHttpFault::Transient { status, .. } => assert_eq!(status, 403),
            other => panic!("expected Transient, got {other:?}"),
        }
    }

    #[test]
    fn classify_status_maps_403_non_hue_body_to_transient() {
        match classify(403, "<html>proxy denied</html>") {
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
        assert!(matches!(classify(401, body), HueHttpFault::AuthInvalid));
    }

    #[test]
    fn classify_status_maps_401_non_hue_body_to_transient() {
        match classify(401, "<html>proxy auth required</html>") {
            HueHttpFault::Transient { status, .. } => assert_eq!(status, 401),
            other => panic!("expected Transient, got {other:?}"),
        }
    }

    #[test]
    fn classify_status_maps_404_to_not_found() {
        assert!(matches!(classify(404, ""), HueHttpFault::NotFound));
    }

    #[test]
    fn classify_status_maps_429_to_rate_limited() {
        match classify(429, r#"{"errors":[{"description":"rate limit"}]}"#) {
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
        assert_eq!(classify(429, "").throttle_hint(), Some(None));
        assert_eq!(classify(503, "").throttle_hint(), Some(None));
        // A 429 is a throttle instruction, never a re-pair one.
        assert!(!matches!(
            classify(429, r#"[{"error":{"type":1}}]"#),
            HueHttpFault::AuthInvalid
        ));
        // Everything else must leave a paced sender's interval alone.
        assert_eq!(classify(400, "").throttle_hint(), None);
        assert_eq!(classify(404, "").throttle_hint(), None);
        assert_eq!(HueHttpFault::AuthInvalid.throttle_hint(), None);
    }

    #[test]
    fn with_retry_after_only_enriches_the_rate_limited_variant() {
        match classify(429, "").with_retry_after(Some(2_000)) {
            HueHttpFault::RateLimited { retry_after_ms, .. } => {
                assert_eq!(retry_after_ms, Some(2_000));
            }
            other => panic!("expected RateLimited, got {other:?}"),
        }
        assert!(matches!(
            classify(404, "").with_retry_after(Some(2_000)),
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
        match classify(503, "") {
            HueHttpFault::ServerError { status } => assert_eq!(status, 503),
            other => panic!("expected ServerError, got {other:?}"),
        }
    }
}
