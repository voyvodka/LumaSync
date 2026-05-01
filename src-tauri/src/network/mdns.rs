//! Process-wide mDNS service browser (v1.5 W2-A3).
//!
//! Why a shared registry? `mdns-sd` opens a UDP multicast socket on the
//! mDNS port (`5353`) when constructed. On macOS spawning two
//! `ServiceDaemon` instances inside one process triggers `SO_REUSEPORT`
//! contention and one of the responders silently misses replies.
//!
//! The registry below holds one `ServiceDaemon` per process and hands
//! out `Arc`-shared receivers per service type. Hue's `_hue._tcp.local.`
//! browser is the v1.5 W2-A3 first consumer; v1.6 WLED discovery
//! (`_wled._tcp.local.`) will plug into the same registry without
//! spawning a second daemon.
//!
//! Public surface:
//!
//! - [`MdnsRegistry::global`] — lazy singleton.
//! - [`MdnsRegistry::browse`] — start (or attach to) a browser for a
//!   service type, returns a snapshot helper that drains advertised
//!   instances over a bounded window.
//! - [`MdnsBridgeCandidate`] — convenience DTO consumed by Hue
//!   discovery; matches the `(id, ip, name)` shape the cloud-discovery
//!   parser already produces so the merge step is trivial.

use std::collections::HashMap;
use std::net::Ipv4Addr;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use log::{debug, info, warn};
use mdns_sd::{ResolvedService, ServiceDaemon, ServiceEvent};

/// Status codes mirrored on the frontend `HUE_STATUS` map.
///
/// These are the canonical wire codes for mDNS-related telemetry.
/// `discover_hue_bridges` currently degrades mDNS errors silently (the
/// cloud path is the primary source of truth), so the constants are
/// referenced only by `MdnsBrowserError::status_code` and the tests.
/// Kept as published surface so a future telemetry panel can light up
/// without reaching back into private string literals.
#[allow(dead_code)]
pub mod status {
    pub const MDNS_DISCOVERY_OK: &str = "HUE_MDNS_DISCOVERY_OK";
    pub const MDNS_DISCOVERY_TIMEOUT: &str = "HUE_MDNS_DISCOVERY_TIMEOUT";
    pub const MDNS_UNSUPPORTED: &str = "HUE_MDNS_UNSUPPORTED";
}

/// Lightweight DTO returned by Hue mDNS browsing. Mirrors the cloud
/// discovery output enough that `discover_hue_bridges` can dedupe by
/// bridge id without translating between two different shapes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MdnsBridgeCandidate {
    /// Bridge id (TXT record `bridgeid` or instance name suffix). Always
    /// uppercase so it dedupes against the cloud-discovery output, which
    /// uppercases its ids in the same way.
    pub id: String,
    /// First IPv4 address advertised by the bridge.
    pub ip: String,
    /// Human-readable instance name as advertised over DNS-SD.
    pub name: String,
}

/// Process-wide mDNS daemon + active browser registry.
pub struct MdnsRegistry {
    daemon: Option<ServiceDaemon>,
    /// Cached `Receiver` per service type so multiple callers attaching to
    /// the same service share one browser. The `Arc<Mutex<_>>` lets a
    /// short-lived snapshot drain events while the underlying browser
    /// keeps running for follow-up snapshots.
    browsers: Mutex<HashMap<String, Arc<Mutex<mdns_sd::Receiver<ServiceEvent>>>>>,
}

static GLOBAL: OnceLock<MdnsRegistry> = OnceLock::new();

impl MdnsRegistry {
    /// Lazily build the process-wide registry. If the underlying
    /// `ServiceDaemon` cannot be created (no IPv4 stack, sandbox-denied
    /// multicast), the registry stays in a "daemon: None" state and
    /// every browse call returns `MdnsBrowserError::Unsupported` — the
    /// caller (Hue discovery) falls back to cloud-only discovery.
    pub fn global() -> &'static MdnsRegistry {
        GLOBAL.get_or_init(|| {
            let daemon = match ServiceDaemon::new() {
                Ok(d) => {
                    info!("[mdns] ServiceDaemon initialised");
                    Some(d)
                }
                Err(err) => {
                    warn!(
                        "[mdns] ServiceDaemon unavailable on this platform — \
                         LAN discovery disabled (cloud fallback still works): {err}"
                    );
                    None
                }
            };
            MdnsRegistry {
                daemon,
                browsers: Mutex::new(HashMap::new()),
            }
        })
    }

    /// Subscribe to a service type and return a handle that lets the caller
    /// drain `ServiceEvent`s with a deadline. Subsequent calls for the same
    /// `service_type` re-use the existing browser so a second `browse` does
    /// not spawn a duplicate responder.
    pub fn browse(&self, service_type: &str) -> Result<MdnsBrowseHandle, MdnsBrowserError> {
        let Some(daemon) = self.daemon.as_ref() else {
            return Err(MdnsBrowserError::Unsupported);
        };

        let mut guard = self
            .browsers
            .lock()
            .map_err(|_| MdnsBrowserError::Poisoned)?;

        if let Some(existing) = guard.get(service_type) {
            return Ok(MdnsBrowseHandle {
                receiver: Arc::clone(existing),
            });
        }

        let receiver = daemon
            .browse(service_type)
            .map_err(|err| MdnsBrowserError::BrowseFailed(format!("{err}")))?;
        let arc_rx = Arc::new(Mutex::new(receiver));
        guard.insert(service_type.to_string(), Arc::clone(&arc_rx));
        debug!("[mdns] browser started for {service_type}");
        Ok(MdnsBrowseHandle { receiver: arc_rx })
    }
}

/// Fault surface returned by [`MdnsRegistry::browse`].
#[derive(Debug, Clone)]
pub enum MdnsBrowserError {
    /// `ServiceDaemon::new()` failed at registry initialisation. Caller
    /// should fall back to cloud discovery.
    Unsupported,
    /// `daemon.browse()` rejected the service type. Surfaces the inner
    /// error message for telemetry.
    BrowseFailed(String),
    /// Internal mutex poisoned by a previous panic — extremely rare.
    Poisoned,
}

impl MdnsBrowserError {
    /// Map the error variant to its canonical wire code. Unused in
    /// production today (silent degradation) but referenced by tests
    /// + the future telemetry panel.
    #[allow(dead_code)]
    pub fn status_code(&self) -> &'static str {
        match self {
            MdnsBrowserError::Unsupported => status::MDNS_UNSUPPORTED,
            MdnsBrowserError::BrowseFailed(_) | MdnsBrowserError::Poisoned => {
                status::MDNS_DISCOVERY_TIMEOUT
            }
        }
    }
}

impl std::fmt::Display for MdnsBrowserError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MdnsBrowserError::Unsupported => f.write_str("mDNS responder unavailable"),
            MdnsBrowserError::BrowseFailed(msg) => write!(f, "mDNS browse failed: {msg}"),
            MdnsBrowserError::Poisoned => f.write_str("mDNS registry mutex poisoned"),
        }
    }
}

/// Active browser handle that lets a caller drain advertised services
/// over a bounded window without owning the registry.
pub struct MdnsBrowseHandle {
    receiver: Arc<Mutex<mdns_sd::Receiver<ServiceEvent>>>,
}

impl MdnsBrowseHandle {
    /// Drain `ServiceResolved` events for up to `deadline`. Returns
    /// every fully-resolved instance the registry observed during the
    /// window (deduplicated by hostname).
    ///
    /// mdns-sd 0.19 reshaped `ServiceEvent::ServiceResolved` from
    /// `ServiceInfo` to `Box<ResolvedService>`; we unbox into a plain
    /// `ResolvedService` here so callers downstream see a uniform value
    /// type instead of paying the heap-indirection on every accessor.
    pub fn snapshot(&self, deadline: Duration) -> Vec<ResolvedService> {
        let started = Instant::now();
        let mut found: HashMap<String, ResolvedService> = HashMap::new();
        let Ok(rx) = self.receiver.lock() else {
            return Vec::new();
        };

        loop {
            let remaining = deadline.checked_sub(started.elapsed());
            let Some(remaining) = remaining else {
                break;
            };
            // 250ms upper bound on each poll keeps the loop responsive
            // without busy-looping when no events arrive.
            let poll = remaining.min(Duration::from_millis(250));
            match rx.recv_timeout(poll) {
                Ok(ServiceEvent::ServiceResolved(info)) => {
                    let key = info.get_hostname().to_string();
                    found.insert(key, *info);
                }
                Ok(_) => continue,
                Err(_) => {
                    // recv_timeout returns Timeout most often; any error
                    // (Disconnected, Again) collapses to "no event this poll".
                    if started.elapsed() >= deadline {
                        break;
                    }
                }
            }
        }
        found.into_values().collect()
    }
}

// ---------------------------------------------------------------------------
// Hue-specific helpers
// ---------------------------------------------------------------------------

/// DNS-SD service type advertised by Hue bridges (CLIP v2-capable models).
pub const HUE_SERVICE_TYPE: &str = "_hue._tcp.local.";

/// Browse `_hue._tcp.local.` for `deadline` and return the resolved bridges
/// projected onto the [`MdnsBridgeCandidate`] DTO.
///
/// Returns `Ok(Vec)` even when no bridges respond — the caller dedupes
/// against cloud discovery and decides whether to surface the empty
/// state. Only true backend errors (`Unsupported`, `BrowseFailed`)
/// propagate as `Err`.
pub fn browse_hue_bridges(
    deadline: Duration,
) -> Result<Vec<MdnsBridgeCandidate>, MdnsBrowserError> {
    let registry = MdnsRegistry::global();
    let handle = registry.browse(HUE_SERVICE_TYPE)?;
    let infos = handle.snapshot(deadline);
    let mut bridges: Vec<MdnsBridgeCandidate> = infos
        .into_iter()
        .filter_map(parse_hue_service_info)
        .collect();
    // Stable order so callers can compare snapshots in tests / telemetry.
    bridges.sort_by(|a, b| a.id.cmp(&b.id));
    bridges.dedup_by(|a, b| a.id == b.id);
    Ok(bridges)
}

/// Parse a single `_hue._tcp.local.` `ResolvedService` into the cloud-shaped
/// candidate DTO. Falls back gracefully when the bridge omits TXT
/// records (`bridgeid`) and synthesises an id from the instance name.
///
/// mdns-sd 0.19 swapped `ServiceInfo` for `ResolvedService` and replaced
/// `get_addresses() -> &HashSet<IpAddr>` with `get_addresses_v4() ->
/// HashSet<Ipv4Addr>`. The new accessor already strips IPv6 entries and
/// scope ids, so we just take the first available v4.
pub(crate) fn parse_hue_service_info(info: ResolvedService) -> Option<MdnsBridgeCandidate> {
    let ip = info
        .get_addresses_v4()
        .into_iter()
        .next()
        .map(|v4| v4.to_string())
        .or_else(|| {
            // Fallback: if Service has no resolved IPv4 yet, try parsing
            // the hostname into an Ipv4Addr (defensive — shouldn't normally
            // happen because mdns-sd emits ServiceResolved only after A-record).
            info.get_hostname()
                .parse::<Ipv4Addr>()
                .ok()
                .map(|v| v.to_string())
        })?;

    // TXT record key. Hue v2 bridges advertise `bridgeid=<UPPER_HEX>`.
    let txt_id = info
        .get_property("bridgeid")
        .and_then(|p| p.val_str().to_string().into())
        .filter(|s: &String| !s.is_empty());
    let id = txt_id.map(|s: String| s.to_uppercase()).or_else(|| {
        // Fallback: derive an id from the instance name, e.g.
        // "Hue Bridge - ABCDEF._hue._tcp.local." → "ABCDEF".
        let full = info.get_fullname();
        full.split('-')
            .next_back()
            .map(|s| s.trim_end_matches("._hue._tcp.local.").to_uppercase())
            .filter(|s| !s.is_empty())
    })?;

    let name = {
        let raw = info.get_fullname();
        let trimmed = raw.strip_suffix("._hue._tcp.local.").unwrap_or(raw).trim();
        if trimmed.is_empty() {
            "Hue Bridge".to_string()
        } else {
            trimmed.to_string()
        }
    };

    Some(MdnsBridgeCandidate { id, ip, name })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_codes_match_frontend_contract() {
        assert_eq!(status::MDNS_DISCOVERY_OK, "HUE_MDNS_DISCOVERY_OK");
        assert_eq!(status::MDNS_DISCOVERY_TIMEOUT, "HUE_MDNS_DISCOVERY_TIMEOUT");
        assert_eq!(status::MDNS_UNSUPPORTED, "HUE_MDNS_UNSUPPORTED");
    }

    #[test]
    fn hue_service_type_matches_dnssd_spec() {
        assert_eq!(HUE_SERVICE_TYPE, "_hue._tcp.local.");
    }

    #[test]
    fn browser_error_routes_to_correct_status_code() {
        assert_eq!(
            MdnsBrowserError::Unsupported.status_code(),
            "HUE_MDNS_UNSUPPORTED"
        );
        assert_eq!(
            MdnsBrowserError::BrowseFailed("x".into()).status_code(),
            "HUE_MDNS_DISCOVERY_TIMEOUT"
        );
        assert_eq!(
            MdnsBrowserError::Poisoned.status_code(),
            "HUE_MDNS_DISCOVERY_TIMEOUT"
        );
    }

    #[test]
    fn browser_error_display_includes_inner_message() {
        let err = MdnsBrowserError::BrowseFailed("timeout".into());
        let s = format!("{err}");
        assert!(s.contains("timeout"));
    }

    #[test]
    fn registry_global_is_singleton() {
        let a = MdnsRegistry::global() as *const _;
        let b = MdnsRegistry::global() as *const _;
        assert_eq!(a, b);
    }

    #[test]
    fn bridge_candidate_dto_dedupes_by_id_via_eq() {
        let a = MdnsBridgeCandidate {
            id: "ABC".into(),
            ip: "10.0.0.1".into(),
            name: "Hue Bridge".into(),
        };
        let b = MdnsBridgeCandidate {
            id: "ABC".into(),
            ip: "10.0.0.1".into(),
            name: "Hue Bridge".into(),
        };
        assert_eq!(a, b);
    }
}
