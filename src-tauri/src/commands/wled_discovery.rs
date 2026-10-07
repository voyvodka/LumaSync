//! WLED device discovery and sink connection commands.
//!
//! A device is added by the address WLED shows, or picked from what `browse_wled_devices` found
//! over mDNS. `WledDiscoveryResponse.devices` is a `Vec<WledDeviceInfo>` either way: empty on
//! failure, `[device]` for an address, every device that answered for a browse.
//!
//! Status codes:
//!   WLED_DISCOVERY_OK          -- /json/info responded; device info parsed.
//!   WLED_DISCOVERY_TIMEOUT     -- HTTP request timed out (2 s).
//!   WLED_DISCOVERY_UNREACHABLE -- Connection refused / network error.
//!   WLED_PROTOCOL_MISMATCH     -- Response is not valid WLED JSON, or is a
//!                                 redirect (never followed).
//!   WLED_LED_COUNT_MISMATCH    -- Requested ledCount != device-reported count.
//!   WLED_BRIDGE_UNREACHABLE    -- connect/test: device not reachable.
//!   WLED_CONNECT_OK            -- Sink built and registered.
//!   WLED_TEST_LIVE_CONFIRMED   -- Frame sent AND /json/info.live read back true.
//!   WLED_TEST_SENT_UNCONFIRMED -- Frame written to the socket, delivery unproven.
//!   WLED_REALTIME_PORT_MISMATCH-- Configured port is not the device's udpport.
//!   WLED_TEST_SEND_FAILED      -- Test frame UDP send failed.
//!   WLED_INVALID_IP            -- IP failed SSRF guard (not IPv4, loopback,
//!                                 unspecified, multicast, or broadcast).
//!   WLED_INVALID_LED_COUNT     -- led_count == 0 supplied to connect_wled_sink.
//!   WLED_BROWSE_OK             -- The mDNS browse ran; `devices` may be empty.
//!   WLED_BROWSE_UNSUPPORTED    -- No mDNS on this machine; the address path still works.
//!   WLED_BROWSE_FAILED         -- The browse could not start.
//!   WLED_BROWSE_WORKER_FAILED  -- The browse's worker died.
//!   WLED_FORGET_OK             -- Device forgotten: not driven, not bound, not saved.
//!   WLED_FORGET_FAILED         -- Not forgotten. If the lighting would not let go, nothing
//!                                 changed; if only the save failed, it is already let go
//!                                 and still saved, and Forget again finishes it.
use std::io::Read;
use std::net::Ipv4Addr;
use std::str::FromStr;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use super::hue::transport::is_valid_bridge_addr;
use super::led_sink::LedSink;
use super::local_outputs::{self, LocalOutputRegistry};
use super::status::CommandStatus;
use super::wled_sink::{WledProtocol, WledSinkConfig, WledUdpSink};
use crate::network::mdns::{self, MdnsBrowserError, MdnsWledCandidate};

const WLED_HTTP_TIMEOUT: Duration = Duration::from_secs(2);

/// The largest `/json/info` body read. A real one is a few KB even on a
/// multi-segment install; anything past this is not WLED answering, and
/// reading it unbounded would let any host on the LAN fill our memory.
const WLED_MAX_RESPONSE_BYTES: usize = 1024 * 1024;

/// DDP's own port, fixed by the protocol and independent of the realtime UDP
/// port the user can remap in WLED's settings.
const WLED_DDP_PORT: u16 = 4048;
const WLED_DEFAULT_REALTIME_PORT: u16 = 21324;

/// How long to wait after the test frame before re-reading `/json/info.live`.
/// WLED latches realtime mode on receipt, so this only has to cover LAN flight
/// plus the device's own loop, not a full frame interval.
const WLED_LIVE_READBACK_DELAY: Duration = Duration::from_millis(250);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WledDiscoveryRequest {
    pub ip: String,
}

/// A WLED device's self-reported identity, parsed from `/json/info`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WledDeviceInfo {
    pub ip: String,
    pub mac: Option<String>,
    pub led_count: u16,
    pub name: Option<String>,
    pub version: Option<String>,
}

/// Response from `discover_wled_devices` and `browse_wled_devices`: `devices` is empty on failure.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WledDiscoveryResponse {
    pub status: CommandStatus,
    pub devices: Vec<WledDeviceInfo>,
}

/// Request payload for `connect_wled_sink`.
///
/// The frontend sends a `WledDeviceInfo` object (discovered via `discover_wled_devices`
/// or typed manually). The Rust handler extracts `ip`, `led_count`, and optionally
/// `port` from the nested `device` field, keeping the frontend payload shape stable.
/// `protocol` is optional and defaults to DDP.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WledConnectRequest {
    pub device: WledDeviceInfo,
    pub port: Option<u16>,
    pub protocol: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WledConnectResponse {
    pub status: CommandStatus,
}

/// Request payload for `test_wled_bridge`.
///
/// Matches `WledConnectRequest` shape — the frontend passes the same
/// `WledDeviceInfo` for both connect and test operations.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WledTestRequest {
    pub device: WledDeviceInfo,
    pub port: Option<u16>,
    pub protocol: Option<String>,
}

/// Response from `test_wled_bridge`.
///
/// `send_latency_ms` is the host-side duration of the `send_to` call. UDP has
/// no ACK, so it is not a round trip and excludes network flight and WLED's
/// own processing — the name says so to stop the UI implying otherwise.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WledTestResponse {
    pub status: CommandStatus,
    pub send_latency_ms: Option<u64>,
    pub requested_led_count: Option<u16>,
    pub device_led_count: Option<u16>,
    pub device_realtime_port: Option<u16>,
}

impl WledTestResponse {
    fn failed(status: CommandStatus) -> Self {
        Self {
            status,
            send_latency_ms: None,
            requested_led_count: None,
            device_led_count: None,
            device_realtime_port: None,
        }
    }
}

/// Request payload for `forget_wled_device`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WledForgetRequest {
    pub ip: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WledForgetResponse {
    pub status: CommandStatus,
}

#[derive(Debug, Deserialize)]
struct WledInfoResponse {
    #[serde(default)]
    leds: WledLedsInfo,
    #[serde(default)]
    mac: String,
    #[serde(default)]
    ver: String,
    #[serde(default)]
    name: String,
    /// True while WLED is displaying a realtime source. Read back after the
    /// test frame — the only evidence available that the datagram landed.
    #[serde(default)]
    live: bool,
    /// The device's realtime UDP port. 0 when a build omits the field, which
    /// is why the port check treats 0 as "unknown" rather than a mismatch.
    #[serde(default)]
    udpport: u16,
}

#[derive(Debug, Default, Deserialize)]
struct WledLedsInfo {
    #[serde(default)]
    count: u16,
}

/// `"warls"` still maps, to `Drgb`. No writer ever produced it, but a
/// hand-edited store can, and DRGB is the same realtime UDP transport on the
/// same port that a WARLS user was asking for. `normalizeWledProtocol` does the
/// same on the TS side — both ends absorb it so neither has to trust the other.
fn parse_protocol(s: Option<&str>) -> WledProtocol {
    match s {
        Some("drgb") | Some("warls") => WledProtocol::Drgb,
        _ => WledProtocol::Ddp,
    }
}

fn default_port_for(protocol: WledProtocol) -> u16 {
    match protocol {
        WledProtocol::Ddp => WLED_DDP_PORT,
        WledProtocol::Drgb => WLED_DEFAULT_REALTIME_PORT,
    }
}

/// Validate an IPv4 address string, rejecting addresses that could enable
/// SSRF or produce undefined routing behavior.
///
/// Rejected ranges (all return `WLED_INVALID_IP`):
///   - Not parseable as IPv4
///   - 127.0.0.0/8  (loopback)
///   - 0.0.0.0      (unspecified)
///   - 224.0.0.0/4  (multicast)
///   - 255.255.255.255 (broadcast)
fn parse_ipv4(ip: &str) -> Result<Ipv4Addr, String> {
    let addr = Ipv4Addr::from_str(ip)
        .map_err(|_| format!("WLED_INVALID_IP: '{}' is not a valid IPv4 address", ip))?;

    if addr.is_loopback() {
        return Err(format!("WLED_INVALID_IP: '{}' is a loopback address", ip));
    }
    if addr.is_unspecified() {
        return Err(format!(
            "WLED_INVALID_IP: '{}' is the unspecified address",
            ip
        ));
    }
    if addr.is_multicast() {
        return Err(format!("WLED_INVALID_IP: '{}' is a multicast address", ip));
    }
    if addr.is_broadcast() {
        return Err(format!(
            "WLED_INVALID_IP: '{}' is the broadcast address",
            ip
        ));
    }

    Ok(addr)
}

/// How often the bound WLED device is asked whether it is there. UDP says nothing when a panel
/// is off, so this is the only way to know; WLED answers HTTP while it takes DDP.
const WLED_PROBE_EVERY: Duration = Duration::from_secs(10);
/// Missed probes in a row before it reads as unreachable: one lost answer is not a panel turned off.
const WLED_MISSES_TO_UNREACHABLE: u32 = 2;
/// Longer than a fetch's: an ESP8266 streaming a long strip can be slow to answer HTTP.
const WLED_PROBE_TIMEOUT: Duration = Duration::from_secs(4);

/// One probe's effect: the misses in a row after it, and `Some(reachable)` to report, `None`
/// while misses are still under the threshold. An answer resets the count and reports reachable.
pub(crate) fn wled_probe_verdict(misses: u32, answered: bool) -> (u32, Option<bool>) {
    if answered {
        return (0, Some(true));
    }
    let misses = misses.saturating_add(1);
    (
        misses,
        (misses >= WLED_MISSES_TO_UNREACHABLE).then_some(false),
    )
}

/// For the app's life: while a WLED device is bound, probe it and publish a change in whether
/// it answers. Only the registry's `reachable` moves; what the "usb" channel drives never does.
pub fn spawn_wled_probe<R: tauri::Runtime>(app: tauri::AppHandle<R>) {
    use tauri::Manager;
    tauri::async_runtime::spawn(async move {
        let mut misses = 0u32;
        let mut probing: Option<(Ipv4Addr, u64)> = None;
        loop {
            tokio::time::sleep(WLED_PROBE_EVERY).await;
            let registry = app.state::<LocalOutputRegistry>();
            let Some(target) = registry.wled_probe_target() else {
                probing = None;
                continue;
            };
            // A new binding starts its own count.
            if probing != Some(target) {
                probing = Some(target);
                misses = 0;
            }
            let (ip, generation) = target;
            let answered = tokio::task::spawn_blocking(move || wled_answers(ip))
                .await
                .unwrap_or(false);
            let (after, verdict) = wled_probe_verdict(misses, answered);
            misses = after;
            let Some(reachable) = verdict else {
                continue;
            };
            if let Some(snapshot) = registry.wled_reachability(ip, generation, reachable) {
                if reachable {
                    log::info!("[wled-probe] {ip} answers again");
                } else {
                    log::warn!("[wled-probe] {ip} stopped answering");
                }
                local_outputs::announce(&app, snapshot);
            }
        }
    });
}

/// Whether the bound device answers HTTP at all.
fn wled_answers(ip: Ipv4Addr) -> bool {
    if parse_ipv4(&ip.to_string()).is_err() {
        return false;
    }
    let started = std::time::Instant::now();
    let answered = probe_answers(&format!("http://{ip}/json/info"), WLED_PROBE_TIMEOUT);
    if answered {
        log::debug!(
            "[wled-probe] {ip} answered in {} ms",
            started.elapsed().as_millis()
        );
    }
    answered
}

/// Any status counts, a 503 too: a device too busy to build `/json/info` is still powered.
/// Only no answer at all is a miss.
fn probe_answers(url: &str, timeout: Duration) -> bool {
    let client = match reqwest::blocking::Client::builder()
        .timeout(timeout)
        .redirect(reqwest::redirect::Policy::none())
        .build()
    {
        Ok(client) => client,
        Err(error) => {
            log::warn!("[wled-probe] could not build its HTTP client: {error}");
            return false;
        }
    };
    client.get(url).send().is_ok()
}

fn fetch_wled_info(ip: &str) -> Result<WledInfoResponse, CommandStatus> {
    // SECURITY: Validate the input IP address to prevent SSRF vulnerabilities.
    // parse_ipv4 rejects loopback, unspecified, multicast, and broadcast in
    // addition to non-parseable strings.
    if let Err(msg) = parse_ipv4(ip) {
        return Err(CommandStatus::new(
            "WLED_INVALID_IP",
            "Invalid WLED device IP address format.",
            Some(msg),
        ));
    }

    fetch_info_from(&format!("http://{}/json/info", ip))
}

/// The one WLED HTTP client. Redirects are never followed: `parse_ipv4`
/// vets only the address the user typed, so a device answering with a
/// redirect could otherwise send the request to loopback or anywhere else.
fn wled_http_client() -> Result<reqwest::blocking::Client, CommandStatus> {
    reqwest::blocking::Client::builder()
        .timeout(WLED_HTTP_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| {
            CommandStatus::new(
                "WLED_CLIENT_BUILD_FAILED",
                "Failed to build HTTP client.",
                Some(e.to_string()),
            )
        })
}

/// `/json/info` from an already-vetted URL.
fn fetch_info_from(url: &str) -> Result<WledInfoResponse, CommandStatus> {
    let client = wled_http_client()?;

    let response = client.get(url).send().map_err(|e| {
        if e.is_timeout() {
            CommandStatus::new(
                "WLED_DISCOVERY_TIMEOUT",
                "WLED device did not respond within 2 seconds.",
                Some(format!("GET {} timed out", url)),
            )
        } else {
            CommandStatus::new(
                "WLED_DISCOVERY_UNREACHABLE",
                "Could not reach WLED device.",
                Some(e.to_string()),
            )
        }
    })?;

    if response.status().is_redirection() {
        let location = response
            .headers()
            .get(reqwest::header::LOCATION)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("(no Location)");
        return Err(CommandStatus::new(
            "WLED_PROTOCOL_MISMATCH",
            "WLED device answered with a redirect, which is not followed.",
            Some(format!("HTTP {} to {location}", response.status().as_u16())),
        ));
    }

    if !response.status().is_success() {
        return Err(CommandStatus::new(
            "WLED_PROTOCOL_MISMATCH",
            "WLED device returned an unexpected HTTP status.",
            Some(format!("HTTP {}", response.status().as_u16())),
        ));
    }

    let info = read_info_body(response)?;

    if info.leds.count == 0 {
        return Err(CommandStatus::new(
            "WLED_PROTOCOL_MISMATCH",
            "WLED /json/info response is missing leds.count.",
            None,
        ));
    }

    Ok(info)
}

// ---------------------------------------------------------------------------
// Switching a device off — the lighting transaction's Off
// ---------------------------------------------------------------------------

/// Longest a switch-off may take. It runs beside the Hue stop on a user's Off,
/// so a device that does not answer costs this, never the 2 s probe timeout.
pub(crate) const WLED_POWER_OFF_TIMEOUT: Duration = Duration::from_millis(1_500);

/// Why a switch-off did not land. Logged, never raised and never on the wire,
/// so the variant is the code: the stream has already stopped, and a device
/// that missed the write only falls back to its own effect once it leaves
/// realtime mode.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum WledPowerOffError {
    /// The address failed the same guard discovery applies (`parse_ipv4`).
    InvalidIp(String),
    Timeout,
    Unreachable(String),
    /// Answered, but not with WLED's `{"success":true}` — a redirect, an error
    /// status, or something that is not WLED.
    Refused(String),
}

/// `POST /json/state {"on":false}`: the device goes dark and stays dark when
/// it leaves realtime mode, instead of returning to its own effect. WLED still
/// shows realtime frames while off, so the next mode lights it again.
/// docs/architecture/device-output.md ("Off switches a WLED device off").
pub(crate) fn power_off_wled(ip: Ipv4Addr) -> Result<(), WledPowerOffError> {
    parse_ipv4(&ip.to_string()).map_err(WledPowerOffError::InvalidIp)?;
    post_power_off(&format!("http://{ip}/json/state"), WLED_POWER_OFF_TIMEOUT)
}

/// The switch-off against an already-vetted URL.
fn post_power_off(url: &str, timeout: Duration) -> Result<(), WledPowerOffError> {
    let client =
        wled_http_client().map_err(|status| WledPowerOffError::Unreachable(status.message))?;
    let response = client
        .post(url)
        .timeout(timeout)
        .json(&serde_json::json!({ "on": false }))
        .send()
        .map_err(|error| {
            if error.is_timeout() {
                WledPowerOffError::Timeout
            } else {
                WledPowerOffError::Unreachable(error.to_string())
            }
        })?;
    let status = response.status();
    if !status.is_success() {
        return Err(WledPowerOffError::Refused(format!(
            "HTTP {}",
            status.as_u16()
        )));
    }
    let mut body = Vec::new();
    response
        .take(WLED_MAX_RESPONSE_BYTES as u64)
        .read_to_end(&mut body)
        .map_err(|error| WledPowerOffError::Unreachable(error.to_string()))?;
    let accepted = serde_json::from_slice::<serde_json::Value>(&body)
        .ok()
        .and_then(|value| value.get("success")?.as_bool())
        == Some(true);
    if accepted {
        Ok(())
    } else {
        Err(WledPowerOffError::Refused(
            "the answer was not WLED's {\"success\":true}".to_string(),
        ))
    }
}

/// Parses `/json/info`, refusing a body past [`WLED_MAX_RESPONSE_BYTES`].
fn read_info_body(
    response: reqwest::blocking::Response,
) -> Result<WledInfoResponse, CommandStatus> {
    let mut body = Vec::new();
    response
        .take(WLED_MAX_RESPONSE_BYTES as u64 + 1)
        .read_to_end(&mut body)
        .map_err(|e| {
            CommandStatus::new(
                "WLED_PROTOCOL_MISMATCH",
                "Response from device is not valid WLED JSON.",
                Some(e.to_string()),
            )
        })?;
    if body.len() > WLED_MAX_RESPONSE_BYTES {
        return Err(CommandStatus::new(
            "WLED_PROTOCOL_MISMATCH",
            "Response from device is too large to be WLED.",
            Some(format!("body exceeds {WLED_MAX_RESPONSE_BYTES} bytes")),
        ));
    }
    serde_json::from_slice(&body).map_err(|e| {
        CommandStatus::new(
            "WLED_PROTOCOL_MISMATCH",
            "Response from device is not valid WLED JSON.",
            Some(e.to_string()),
        )
    })
}

fn info_to_device(ip: &str, info: WledInfoResponse) -> WledDeviceInfo {
    WledDeviceInfo {
        ip: ip.to_string(),
        mac: if info.mac.is_empty() {
            None
        } else {
            Some(info.mac)
        },
        led_count: info.leds.count,
        name: if info.name.is_empty() {
            None
        } else {
            Some(info.name)
        },
        version: if info.ver.is_empty() {
            None
        } else {
            Some(info.ver)
        },
    }
}

/// Probe a WLED device's `/json/info` endpoint and report its identity.
// `async fn` + `spawn_blocking` because a sync command runs on the main thread:
// an unreachable device froze the UI for the whole `WLED_HTTP_TIMEOUT`.
#[tauri::command]
pub async fn discover_wled_devices(request: WledDiscoveryRequest) -> WledDiscoveryResponse {
    tokio::task::spawn_blocking(move || discover_wled_devices_blocking(request))
        .await
        .unwrap_or_else(|join_error| WledDiscoveryResponse {
            status: CommandStatus::new(
                "WLED_DISCOVERY_WORKER_FAILED",
                "WLED discovery worker terminated unexpectedly.",
                Some(join_error.to_string()),
            ),
            devices: Vec::new(),
        })
}

fn discover_wled_devices_blocking(request: WledDiscoveryRequest) -> WledDiscoveryResponse {
    match fetch_wled_info(&request.ip) {
        Ok(info) => {
            let device = info_to_device(&request.ip, info);
            WledDiscoveryResponse {
                status: CommandStatus::ok(
                    "WLED_DISCOVERY_OK",
                    "WLED device found and info parsed.",
                ),
                devices: vec![device],
            }
        }
        Err(status) => WledDiscoveryResponse {
            status,
            devices: Vec::new(),
        },
    }
}

/// How long a browse listens for WLED's mDNS adverts.
const WLED_BROWSE_FOR: Duration = Duration::from_millis(2500);
/// At most this many devices are asked at once: anything on the LAN can advertise.
const WLED_BROWSE_MAX_DEVICES: usize = 32;

/// Looks for WLED devices on the local network and asks each what it is.
#[tauri::command]
pub async fn browse_wled_devices() -> WledDiscoveryResponse {
    tokio::task::spawn_blocking(|| {
        browse_wled_with(mdns::browse_wled_devices, |ip| {
            fetch_wled_info(&ip.to_string()).ok()
        })
    })
    .await
    .unwrap_or_else(|join_error| WledDiscoveryResponse {
        status: CommandStatus::new(
            "WLED_BROWSE_WORKER_FAILED",
            "WLED browse worker terminated unexpectedly.",
            Some(join_error.to_string()),
        ),
        devices: Vec::new(),
    })
}

fn browse_wled_with(
    browse: impl FnOnce(Duration) -> Result<Vec<MdnsWledCandidate>, MdnsBrowserError>,
    fetch: impl Fn(Ipv4Addr) -> Option<WledInfoResponse> + Sync,
) -> WledDiscoveryResponse {
    let candidates = match browse(WLED_BROWSE_FOR) {
        Ok(candidates) => candidates,
        Err(MdnsBrowserError::Unsupported) => {
            return WledDiscoveryResponse {
                status: CommandStatus::new(
                    "WLED_BROWSE_UNSUPPORTED",
                    "mDNS is not available on this machine.",
                    None,
                ),
                devices: Vec::new(),
            }
        }
        Err(error) => {
            return WledDiscoveryResponse {
                status: CommandStatus::new(
                    "WLED_BROWSE_FAILED",
                    "Looking for WLED devices could not start.",
                    Some(error.to_string()),
                ),
                devices: Vec::new(),
            }
        }
    };
    WledDiscoveryResponse {
        status: CommandStatus::ok("WLED_BROWSE_OK", "WLED browse finished."),
        devices: identify_wled_candidates(candidates, fetch),
    }
}

/// Asks each advertised device what it is, all at once, and keeps those that answer as WLED.
// Only an address on the local network is asked: anything on the LAN can advertise, and naming a
// public address would have the app fetch from it unasked. The same LAN rule as a Hue bridge's.
fn identify_wled_candidates(
    candidates: Vec<MdnsWledCandidate>,
    fetch: impl Fn(Ipv4Addr) -> Option<WledInfoResponse> + Sync,
) -> Vec<WledDeviceInfo> {
    let mut candidates: Vec<(Ipv4Addr, MdnsWledCandidate)> = candidates
        .into_iter()
        .filter_map(|candidate| {
            let ip = candidate
                .addresses
                .iter()
                .copied()
                .find(|ip| is_valid_bridge_addr(&ip.to_string()))?;
            Some((ip, candidate))
        })
        .collect();
    candidates.sort_by_key(|(ip, _)| *ip);
    candidates.dedup_by_key(|(ip, _)| *ip);
    candidates.truncate(WLED_BROWSE_MAX_DEVICES);
    let fetch = &fetch;
    std::thread::scope(|scope| {
        let asks: Vec<_> = candidates
            .into_iter()
            .map(|(ip, candidate)| scope.spawn(move || fetch(ip).map(|info| (ip, candidate, info))))
            .collect();
        asks.into_iter()
            .filter_map(|ask| ask.join().ok().flatten())
            .map(|(ip, candidate, info)| {
                let mut device = info_to_device(&ip.to_string(), info);
                device.name = device.name.or(Some(candidate.name));
                device.mac = device.mac.or(candidate.mac);
                device
            })
            .collect()
    })
}

/// Bind a WLED device to the "usb" output channel, replacing another WLED device. A connected strip
/// stays connected; the earliest connected output is the one driven.
// Off the main thread: binding the probe socket is a syscall the main thread
// need not wait on.
#[tauri::command]
pub async fn connect_wled_sink<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    request: WledConnectRequest,
) -> WledConnectResponse {
    let worker_app = app.clone();
    let (response, bound) = tokio::task::spawn_blocking(move || {
        use tauri::Manager;
        connect_wled_sink_blocking(request, &worker_app.state::<LocalOutputRegistry>())
    })
    .await
    .unwrap_or_else(|join_error| {
        let response = WledConnectResponse {
            status: CommandStatus::new(
                "WLED_CONNECT_WORKER_FAILED",
                "WLED connect worker terminated unexpectedly.",
                Some(join_error.to_string()),
            ),
        };
        (response, None)
    });
    if let Some(snapshot) = bound {
        local_outputs::announce(&app, snapshot);
        super::lighting_mode::outputs::note_local_sink_connected(&app);
    }
    response
}

fn connect_wled_sink_blocking(
    request: WledConnectRequest,
    registry: &LocalOutputRegistry,
) -> (
    WledConnectResponse,
    Option<local_outputs::LocalOutputsSnapshot>,
) {
    let device = &request.device;

    // Guard: led_count == 0 is not a valid strip configuration.
    if device.led_count == 0 {
        return (
            WledConnectResponse {
                status: CommandStatus::new(
                    "WLED_INVALID_LED_COUNT",
                    "LED count must be greater than zero.",
                    None,
                ),
            },
            None,
        );
    }

    let ip = match parse_ipv4(&device.ip) {
        Ok(addr) => addr,
        Err(msg) => {
            let response = WledConnectResponse {
                status: CommandStatus::new("WLED_INVALID_IP", &msg, None),
            };
            return (response, None);
        }
    };

    let protocol = parse_protocol(request.protocol.as_deref());
    let port = request.port.unwrap_or_else(|| default_port_for(protocol));

    let config = WledSinkConfig {
        ip,
        port,
        led_count: device.led_count,
        protocol,
    };
    let mut sink = config.build();

    if let Err(e) = sink.start() {
        return (
            WledConnectResponse {
                status: CommandStatus::new(
                    "WLED_BRIDGE_UNREACHABLE",
                    "Failed to bind UDP socket for WLED sink.",
                    Some(e),
                ),
            },
            None,
        );
    }

    // `sink` only proved the UDP socket could bind; `lighting_mode.rs`
    // rebuilds a fresh sink per mode-change from `config`, so it sees live
    // colour-correction settings (mirrors `SerialSink`'s rebuild-from-`port_name`).
    let _ = sink.stop();
    let snapshot = registry.wled_bound(config);

    let response = WledConnectResponse {
        status: CommandStatus::ok("WLED_CONNECT_OK", "WLED sink connected and registered."),
    };
    (response, Some(snapshot))
}

/// The body of `forget_wled_device`. Contacts nothing on the network.
pub(crate) async fn forget_wled_with<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    ip: &str,
) -> WledForgetResponse {
    use tauri::Manager;

    let Ok(addr) = Ipv4Addr::from_str(ip.trim()) else {
        return WledForgetResponse {
            status: CommandStatus::new(
                "WLED_INVALID_IP",
                "Not a WLED device address.",
                Some(format!("'{ip}' is not a valid IPv4 address")),
            ),
        };
    };
    if let Some(config) = app
        .state::<LocalOutputRegistry>()
        .wled_config()
        .filter(|config| config.ip == addr)
    {
        let registry = app.state::<LocalOutputRegistry>();
        let connected_at = registry.wled_connected_at();
        // Unbound first, so the lighting re-plans onto what remains rather than onto this device.
        if let Some(snapshot) = registry.wled_forgotten(addr) {
            local_outputs::announce(app, snapshot);
        }
        if let Err(error) = local_outputs::let_go(app, &local_outputs::Left::Wled(config)).await {
            log::warn!("[wled-forget] the lighting did not let go of {addr}: {error}");
            if let Some(snapshot) = registry.restore_wled(config, connected_at) {
                local_outputs::announce(app, snapshot);
            }
            return WledForgetResponse {
                status: CommandStatus::new(
                    "WLED_FORGET_FAILED",
                    "The WLED device was not forgotten.",
                    Some(error),
                ),
            };
        }
    }

    let saved_here = super::shell_state::persisted(app)
        .and_then(|state| state.saved_wled_ip())
        .is_some_and(|saved| saved.trim() == ip.trim());
    if saved_here {
        let forgotten = super::shell_state::update_from_rust(app, |state| {
            crate::models::led_strips::forget_wled_in(state, ip)
        });
        if let Err(error) = forgotten {
            return WledForgetResponse {
                status: CommandStatus::new(
                    "WLED_FORGET_FAILED",
                    "The WLED device was not forgotten.",
                    Some(error),
                ),
            };
        }
    }
    log::info!("[wled-forget] {addr} forgotten");
    WledForgetResponse {
        status: CommandStatus::ok("WLED_FORGET_OK", "The WLED device was forgotten."),
    }
}

/// Forget a WLED device: the running mode stops sending to it (and ends when
/// it was the only output), the sink registration goes, and so does the saved
/// device a launch would bind again.
#[tauri::command]
pub async fn forget_wled_device<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    request: WledForgetRequest,
) -> WledForgetResponse {
    forget_wled_with(&app, &request.ip).await
}

/// Send a one-off red-ramp test frame to a WLED device without registering
/// it as the active sink.
// Same main-thread reasoning as `discover_wled_devices`, and worse here: two HTTP
// round-trips with a `WLED_LIVE_READBACK_DELAY` sleep between them.
#[tauri::command]
pub async fn test_wled_bridge(request: WledTestRequest) -> WledTestResponse {
    tokio::task::spawn_blocking(move || test_wled_bridge_blocking(request))
        .await
        .unwrap_or_else(|join_error| {
            WledTestResponse::failed(CommandStatus::new(
                "WLED_TEST_WORKER_FAILED",
                "WLED test worker terminated unexpectedly.",
                Some(join_error.to_string()),
            ))
        })
}

fn test_wled_bridge_blocking(request: WledTestRequest) -> WledTestResponse {
    let device = &request.device;

    let info = match fetch_wled_info(&device.ip) {
        Ok(info) => info,
        Err(status) => return WledTestResponse::failed(status),
    };

    if info.leds.count != device.led_count {
        return WledTestResponse {
            status: CommandStatus::new(
                "WLED_LED_COUNT_MISMATCH",
                "Requested LED count does not match device-reported LED count.",
                Some(format!(
                    "requested={}, device={}",
                    device.led_count, info.leds.count
                )),
            ),
            send_latency_ms: None,
            requested_led_count: Some(device.led_count),
            device_led_count: Some(info.leds.count),
            device_realtime_port: None,
        };
    }

    let ip = match parse_ipv4(&device.ip) {
        Ok(addr) => addr,
        Err(msg) => {
            return WledTestResponse::failed(CommandStatus::new("WLED_INVALID_IP", &msg, None))
        }
    };

    let protocol = parse_protocol(request.protocol.as_deref());
    let port = request.port.unwrap_or_else(|| default_port_for(protocol));

    // Fail closed on a port nothing listens on: the send would succeed at the
    // socket layer and the old code would have called that a pass. `udpport` 0
    // means the build did not report one, so it cannot contradict anything.
    if protocol == WledProtocol::Drgb && info.udpport != 0 && info.udpport != port {
        return WledTestResponse {
            status: CommandStatus::new(
                "WLED_REALTIME_PORT_MISMATCH",
                "Configured realtime port is not the port this device listens on.",
                Some(format!("configured={}, device={}", port, info.udpport)),
            ),
            send_latency_ms: None,
            requested_led_count: None,
            device_led_count: None,
            device_realtime_port: Some(info.udpport),
        };
    }

    let mut sink = WledUdpSink::new(ip, port, device.led_count, protocol);

    if let Err(e) = sink.start() {
        return WledTestResponse::failed(CommandStatus::new(
            "WLED_BRIDGE_UNREACHABLE",
            "Failed to bind UDP socket for test.",
            Some(e),
        ));
    }

    // Red ramp: LED i -> [i % 256, 0, 0]
    let frame: Vec<[u8; 3]> = (0..device.led_count as usize)
        .map(|i| [(i % 256) as u8, 0, 0])
        .collect();

    let t0 = Instant::now();
    let send_result = sink.send_frame(&frame);
    let elapsed_ms = t0.elapsed().as_millis() as u64;
    let _ = sink.stop();

    if let Err(e) = send_result {
        return WledTestResponse::failed(CommandStatus::new(
            "WLED_TEST_SEND_FAILED",
            "Test frame send failed.",
            Some(e),
        ));
    }

    // The socket accepting the datagram proves nothing about delivery, so ask
    // the device whether it entered realtime mode. A failed re-probe downgrades
    // to unconfirmed rather than failing — the frame may well have landed.
    std::thread::sleep(WLED_LIVE_READBACK_DELAY);
    let live_confirmed = fetch_wled_info(&device.ip)
        .map(|after| after.live)
        .unwrap_or(false);

    let status = if live_confirmed {
        CommandStatus::ok(
            "WLED_TEST_LIVE_CONFIRMED",
            "Test frame sent and the device reported it is displaying a realtime source.",
        )
    } else {
        CommandStatus::ok(
            "WLED_TEST_SENT_UNCONFIRMED",
            "Device reachable and test frame written to the socket, but the device did not confirm it is displaying a realtime source.",
        )
    };

    WledTestResponse {
        status,
        send_latency_ms: Some(elapsed_ms),
        requested_led_count: Some(device.led_count),
        device_led_count: Some(info.leds.count),
        device_realtime_port: (info.udpport != 0).then_some(info.udpport),
    }
}

#[cfg(test)]
mod tests {
    use super::{default_port_for, parse_protocol, WledProtocol};

    #[test]
    fn parse_protocol_ddp_is_default() {
        assert_eq!(parse_protocol(None), WledProtocol::Ddp);
        assert_eq!(parse_protocol(Some("ddp")), WledProtocol::Ddp);
        assert_eq!(parse_protocol(Some("unknown")), WledProtocol::Ddp);
    }

    #[test]
    fn parse_protocol_drgb() {
        assert_eq!(parse_protocol(Some("drgb")), WledProtocol::Drgb);
    }

    /// A store written before the v5 migration still reaches Rust on that
    /// launch, and WARLS users wanted realtime UDP — which is what DRGB is.
    #[test]
    fn parse_protocol_maps_legacy_warls_onto_drgb() {
        assert_eq!(parse_protocol(Some("warls")), WledProtocol::Drgb);
    }

    #[test]
    fn default_port_ddp_is_4048() {
        assert_eq!(default_port_for(WledProtocol::Ddp), 4048);
    }

    #[test]
    fn default_port_drgb_is_the_realtime_port() {
        assert_eq!(default_port_for(WledProtocol::Drgb), 21324);
    }

    #[test]
    fn parse_ipv4_valid_address() {
        let result = super::parse_ipv4("192.168.1.42");
        assert!(result.is_ok());
    }

    #[test]
    fn parse_ipv4_invalid_returns_coded_error() {
        let result = super::parse_ipv4("not-an-ip");
        assert!(result.is_err());
        let msg = result.unwrap_err();
        assert!(msg.starts_with("WLED_INVALID_IP"), "got: {msg}");
    }

    #[test]
    fn parse_ipv4_loopback_is_rejected() {
        let result = super::parse_ipv4("127.0.0.1");
        assert!(result.is_err());
        let msg = result.unwrap_err();
        assert!(msg.starts_with("WLED_INVALID_IP"), "got: {msg}");
    }

    #[test]
    fn parse_ipv4_unspecified_is_rejected() {
        let result = super::parse_ipv4("0.0.0.0");
        assert!(result.is_err());
        let msg = result.unwrap_err();
        assert!(msg.starts_with("WLED_INVALID_IP"), "got: {msg}");
    }

    #[test]
    fn parse_ipv4_multicast_is_rejected() {
        let result = super::parse_ipv4("224.0.0.1");
        assert!(result.is_err());
        let msg = result.unwrap_err();
        assert!(msg.starts_with("WLED_INVALID_IP"), "got: {msg}");
    }

    #[test]
    fn parse_ipv4_broadcast_is_rejected() {
        let result = super::parse_ipv4("255.255.255.255");
        assert!(result.is_err());
        let msg = result.unwrap_err();
        assert!(msg.starts_with("WLED_INVALID_IP"), "got: {msg}");
    }

    #[test]
    fn info_to_device_maps_fields_correctly() {
        use super::{info_to_device, WledInfoResponse, WledLedsInfo};
        let info = WledInfoResponse {
            leds: WledLedsInfo { count: 60 },
            mac: "AA:BB:CC:DD:EE:FF".to_string(),
            ver: "0.14.0".to_string(),
            name: "Living Room".to_string(),
            live: false,
            udpport: 21324,
        };
        let device = info_to_device("10.0.0.5", info);
        assert_eq!(device.ip, "10.0.0.5");
        assert_eq!(device.led_count, 60);
        assert_eq!(device.mac, Some("AA:BB:CC:DD:EE:FF".to_string()));
        assert_eq!(device.version, Some("0.14.0".to_string()));
        assert_eq!(device.name, Some("Living Room".to_string()));
    }

    #[test]
    fn info_to_device_empty_strings_become_none() {
        use super::{info_to_device, WledInfoResponse, WledLedsInfo};
        let info = WledInfoResponse {
            leds: WledLedsInfo { count: 30 },
            mac: String::new(),
            ver: String::new(),
            name: String::new(),
            live: false,
            udpport: 0,
        };
        let device = info_to_device("10.0.0.1", info);
        assert!(device.mac.is_none());
        assert!(device.version.is_none());
        assert!(device.name.is_none());
    }

    /// Answers one request on 127.0.0.1 with `body`, chunked so no
    /// Content-Length announces the size up front.
    fn serve_once(body: Vec<u8>) -> String {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0u8; 1024];
            let _ = stream.read(&mut request);
            let _ = stream.write_all(
                b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n",
            );
            for chunk in body.chunks(64 * 1024) {
                if stream
                    .write_all(format!("{:x}\r\n", chunk.len()).as_bytes())
                    .and_then(|()| stream.write_all(chunk))
                    .and_then(|()| stream.write_all(b"\r\n"))
                    .is_err()
                {
                    return;
                }
            }
            let _ = stream.write_all(b"0\r\n\r\n");
        });
        format!("http://{addr}/json/info")
    }

    fn fetch(url: &str) -> Result<super::WledInfoResponse, super::CommandStatus> {
        let response = super::wled_http_client().unwrap().get(url).send().unwrap();
        super::read_info_body(response)
    }

    /// A LAN device answering `/json/info` with a 302 to a loopback service
    /// that looks like WLED. Following it would reach an address `parse_ipv4`
    /// refuses, so the redirect must end the probe with a code, unfollowed.
    #[test]
    fn a_redirect_is_refused_not_followed() {
        use std::io::{Read, Write};
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;

        let target = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let target_url = format!("http://{}/json/info", target.local_addr().unwrap());
        let target_hit = Arc::new(AtomicBool::new(false));
        let hit = Arc::clone(&target_hit);
        std::thread::spawn(move || {
            let (mut stream, _) = target.accept().unwrap();
            hit.store(true, Ordering::SeqCst);
            let mut request = [0u8; 1024];
            let _ = stream.read(&mut request);
            let body = br#"{"leds":{"count":60}}"#;
            let _ = stream.write_all(
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                )
                .as_bytes(),
            );
            let _ = stream.write_all(body);
        });

        let device = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let device_url = format!("http://{}/json/info", device.local_addr().unwrap());
        let location = target_url.clone();
        std::thread::spawn(move || {
            let (mut stream, _) = device.accept().unwrap();
            let mut request = [0u8; 1024];
            let _ = stream.read(&mut request);
            let _ = stream.write_all(
                format!(
                    "HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                )
                .as_bytes(),
            );
        });

        let status = super::fetch_info_from(&device_url).unwrap_err();

        assert_eq!(status.code, "WLED_PROTOCOL_MISMATCH");
        assert_eq!(
            status.details.as_deref(),
            Some(format!("HTTP 302 to {target_url}").as_str())
        );
        assert!(
            !target_hit.load(Ordering::SeqCst),
            "the redirect target must never be contacted"
        );
    }

    #[test]
    fn info_body_within_the_cap_parses() {
        let info = fetch(&serve_once(
            br#"{"leds":{"count":60},"udpport":21324}"#.to_vec(),
        ))
        .unwrap();
        assert_eq!(info.leds.count, 60);
        assert_eq!(info.udpport, 21324);
    }

    #[test]
    fn info_body_past_the_cap_is_refused() {
        use super::WLED_MAX_RESPONSE_BYTES;
        // Valid JSON the whole way, so only the cap can reject it.
        let mut body = br#"{"leds":{"count":60},"name":""#.to_vec();
        body.resize(WLED_MAX_RESPONSE_BYTES, b'x');
        body.extend_from_slice(br#""}"#);
        assert!(body.len() > WLED_MAX_RESPONSE_BYTES);

        let status = fetch(&serve_once(body)).unwrap_err();
        assert_eq!(status.code, "WLED_PROTOCOL_MISMATCH");
        assert_eq!(
            status.details.as_deref(),
            Some(format!("body exceeds {WLED_MAX_RESPONSE_BYTES} bytes").as_str())
        );
    }

    // ── switching a device off ─────────────────────────────────────────

    /// A WLED stand-in on 127.0.0.1 that answers one request with `reply`
    /// after `delay` and hands back the request it read.
    fn device_once(
        reply: &'static str,
        delay: std::time::Duration,
    ) -> (String, std::sync::mpsc::Receiver<String>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/json/state", listener.local_addr().unwrap());
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let _ = stream.set_read_timeout(Some(std::time::Duration::from_millis(500)));
            let mut request = Vec::new();
            let mut buf = [0u8; 1024];
            while let Ok(n) = stream.read(&mut buf) {
                if n == 0 {
                    break;
                }
                request.extend_from_slice(&buf[..n]);
                let text = String::from_utf8_lossy(&request);
                if text.contains("\r\n\r\n") && text.trim_end().ends_with('}') {
                    break;
                }
            }
            let _ = tx.send(String::from_utf8_lossy(&request).into_owned());
            std::thread::sleep(delay);
            let _ = stream.write_all(reply.as_bytes());
        });
        (url, rx)
    }

    fn json_reply(status: &str, body: &str) -> String {
        format!(
            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
    }

    fn leak(reply: String) -> &'static str {
        Box::leak(reply.into_boxed_str())
    }

    #[test]
    fn a_switch_off_posts_on_false_to_the_state_endpoint() {
        let (url, request) = device_once(
            leak(json_reply("200 OK", r#"{"success":true}"#)),
            std::time::Duration::ZERO,
        );

        assert_eq!(
            super::post_power_off(&url, super::WLED_POWER_OFF_TIMEOUT),
            Ok(())
        );
        let request = request.recv().unwrap();
        assert!(request.starts_with("POST /json/state "), "{request}");
        let body = request.split("\r\n\r\n").nth(1).unwrap_or_default();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(body).unwrap(),
            serde_json::json!({ "on": false })
        );
    }

    #[test]
    fn a_switch_off_is_refused_by_anything_but_wleds_success() {
        for reply in [
            json_reply("200 OK", r#"{"error":9}"#),
            json_reply("500 Internal Server Error", r#"{"success":true}"#),
            "HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/json/state\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_string(),
        ] {
            let (url, _request) = device_once(leak(reply.clone()), std::time::Duration::ZERO);
            let error = super::post_power_off(&url, super::WLED_POWER_OFF_TIMEOUT).unwrap_err();
            assert!(
                matches!(error, super::WledPowerOffError::Refused(_)),
                "{reply}: {error:?}"
            );
        }
    }

    /// A device that does not answer costs the switch-off's own bound, not
    /// the Off it runs beside.
    #[test]
    fn a_silent_device_ends_the_switch_off_at_its_timeout() {
        let (url, _request) = device_once(
            leak(json_reply("200 OK", r#"{"success":true}"#)),
            std::time::Duration::from_secs(3),
        );
        let started = std::time::Instant::now();

        let error = super::post_power_off(&url, std::time::Duration::from_millis(300)).unwrap_err();

        assert_eq!(error, super::WledPowerOffError::Timeout);
        assert!(started.elapsed() < std::time::Duration::from_secs(2));
    }

    #[test]
    fn a_switch_off_is_never_sent_to_an_address_the_guard_refuses() {
        for ip in ["127.0.0.1", "0.0.0.0", "239.1.1.1", "255.255.255.255"] {
            let error = super::power_off_wled(ip.parse().unwrap()).unwrap_err();
            assert!(
                matches!(error, super::WledPowerOffError::InvalidIp(_)),
                "{ip}: {error:?}"
            );
        }
    }
}

#[cfg(test)]
mod forget_tests {
    use serde_json::json;
    use tauri::async_runtime::block_on;
    use tauri::Manager;

    use super::super::lighting_mode::outputs::{
        apply_outputs_with, ApplyOutputsRequest, LightingOrigin,
    };
    use super::super::lighting_mode::{
        LightingModeConfig, LightingModeKind, Rig, RigSetup, SolidColorPayload,
    };
    use super::super::local_outputs::LocalOutputRegistry;
    use super::super::wled_sink::{WledProtocol, WledSinkConfig};
    use super::forget_wled_with;

    // Loopback, with a receiver bound below: a test never sends to the LAN.
    const IP: &str = "127.0.0.1";

    fn rig_with_wled(bind: bool) -> (Rig, std::net::UdpSocket) {
        let receiver = std::net::UdpSocket::bind("127.0.0.1:0").unwrap();
        let port = receiver.local_addr().unwrap().port();
        let rig = Rig::new(RigSetup {
            serial_connected: false,
            hue_paired: false,
            state: json!({
                "lastWledSink": { "ip": IP, "port": port, "ledCount": 59, "protocol": "drgb" },
                "lastOutputTargets": ["usb"],
            }),
            ..RigSetup::default()
        });
        if bind {
            let config = WledSinkConfig {
                ip: IP.parse().unwrap(),
                port,
                led_count: 59,
                protocol: WledProtocol::Drgb,
            };
            rig.app.state::<LocalOutputRegistry>().wled_bound(config);
        }
        (rig, receiver)
    }

    fn solid_on_usb(rig: &Rig) {
        let started = block_on(apply_outputs_with(
            &rig.handle(),
            ApplyOutputsRequest {
                mode: Some(LightingModeConfig {
                    kind: LightingModeKind::Solid,
                    solid: Some(SolidColorPayload {
                        r: 200,
                        g: 20,
                        b: 30,
                        brightness: 1.0,
                        kelvin: None,
                    }),
                    ..LightingModeConfig::default()
                }),
                targets: Some(vec!["usb".to_string()]),
                origin: LightingOrigin::User,
            },
        ))
        .expect("apply resolves");
        assert_eq!(started.status.code, "OUTPUTS_APPLIED", "setup: {started:?}");
    }

    #[test]
    fn forgetting_the_driven_device_ends_its_mode_and_unbinds_it() {
        let (rig, _receiver) = rig_with_wled(true);
        solid_on_usb(&rig);

        let response = block_on(forget_wled_with(&rig.handle(), IP));

        assert_eq!(response.status.code, "WLED_FORGET_OK");
        let snapshot = rig.state().snapshot.read();
        assert_eq!(snapshot.mode.kind, LightingModeKind::Off);
        assert!(snapshot.active_targets.is_empty());
        assert!(!rig.worker_running(), "nothing drives the device any more");
        assert!(rig
            .app
            .state::<LocalOutputRegistry>()
            .wled_config()
            .is_none());
        assert_eq!(rig.saved_wled_ip(), None);
        assert_eq!(
            rig.saved("lastOutputTargets"),
            Some(json!(["usb"])),
            "the local channel stays chosen for the next strip or device"
        );
    }

    #[test]
    fn a_device_that_is_only_saved_is_dropped_without_touching_the_lighting() {
        let (rig, _receiver) = rig_with_wled(false);

        let response = block_on(forget_wled_with(&rig.handle(), IP));

        assert_eq!(response.status.code, "WLED_FORGET_OK");
        assert!(rig.log.events().is_empty(), "{:?}", rig.log.events());
        assert_eq!(rig.saved_wled_ip(), None);
        assert!(
            rig.saved("lastWledSink").is_some(),
            "the legacy key stays frozen for a downgrade"
        );
    }

    #[test]
    fn another_bound_device_is_left_bound() {
        let (rig, _receiver) = rig_with_wled(true);

        let response = block_on(forget_wled_with(&rig.handle(), "127.0.0.2"));

        assert_eq!(response.status.code, "WLED_FORGET_OK");
        assert!(rig
            .app
            .state::<LocalOutputRegistry>()
            .wled_config()
            .is_some());
        assert_eq!(rig.saved_wled_ip().as_deref(), Some(IP));
        assert_eq!(rig.saved("ledStrips"), None, "nothing was written");
    }
}

#[cfg(test)]
mod probe_tests {
    use super::{probe_answers, wled_probe_verdict};
    use std::io::{Read, Write};
    use std::time::Duration;

    /// Answers one request on 127.0.0.1 with `reply`.
    fn answering(reply: &'static str) -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/json/info", listener.local_addr().unwrap());
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = Vec::new();
            let mut buf = [0u8; 1024];
            while !String::from_utf8_lossy(&request).contains("\r\n\r\n") {
                match stream.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => request.extend_from_slice(&buf[..n]),
                }
            }
            let _ = stream.write_all(reply.as_bytes());
        });
        url
    }

    #[test]
    fn a_busy_device_answering_503_is_there_and_a_closed_port_is_not() {
        let busy = answering(
            "HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        );
        assert!(probe_answers(&busy, Duration::from_secs(2)));

        let closed = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/json/info", closed.local_addr().unwrap());
        drop(closed);
        assert!(!probe_answers(&url, Duration::from_secs(2)));
    }

    #[test]
    fn a_device_that_accepts_but_never_answers_is_a_miss() {
        let silent = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/json/info", silent.local_addr().unwrap());
        assert!(!probe_answers(&url, Duration::from_millis(300)));
        drop(silent);
    }

    #[test]
    fn two_missed_probes_in_a_row_read_as_unreachable_and_one_answer_as_back() {
        let (misses, verdict) = wled_probe_verdict(0, false);
        assert_eq!((misses, verdict), (1, None));
        let (misses, verdict) = wled_probe_verdict(misses, false);
        assert_eq!((misses, verdict), (2, Some(false)));
        let (misses, verdict) = wled_probe_verdict(misses, true);
        assert_eq!((misses, verdict), (0, Some(true)));
        // One miss between answers is not a panel turned off.
        assert_eq!(wled_probe_verdict(0, false).1, None);
    }
}

#[cfg(test)]
mod browse_tests {
    use std::net::Ipv4Addr;
    use std::sync::Mutex;

    use super::{
        browse_wled_with, identify_wled_candidates, MdnsBrowserError, MdnsWledCandidate,
        WledInfoResponse, WledLedsInfo,
    };

    fn advert(ip: [u8; 4], name: &str) -> MdnsWledCandidate {
        MdnsWledCandidate {
            addresses: vec![Ipv4Addr::from(ip)],
            name: name.to_string(),
            mac: Some("a0b1c2d3e4f5".to_string()),
        }
    }

    fn info(name: &str, count: u16) -> WledInfoResponse {
        WledInfoResponse {
            leds: WledLedsInfo { count },
            mac: String::new(),
            ver: "0.15.0".to_string(),
            name: name.to_string(),
            live: false,
            udpport: 21324,
        }
    }

    #[test]
    fn only_local_addresses_are_asked_once_each_and_only_what_answers_is_kept() {
        let asked = Mutex::new(Vec::new());
        let devices = identify_wled_candidates(
            vec![
                advert([192, 168, 1, 40], "desk"),
                advert([192, 168, 1, 40], "desk again"),
                advert([8, 8, 8, 8], "public"),
                advert([127, 0, 0, 1], "loopback"),
                advert([192, 168, 1, 41], "silent"),
                advert([169, 254, 3, 3], "shelf"),
                // A public address listed first does not hide the LAN one.
                MdnsWledCandidate {
                    addresses: vec![Ipv4Addr::new(8, 8, 4, 4), Ipv4Addr::new(10, 0, 0, 9)],
                    name: "two addresses".to_string(),
                    mac: None,
                },
            ],
            |ip| {
                asked.lock().unwrap().push(ip);
                match ip.octets() {
                    [192, 168, 1, 40] => Some(info("Desk", 60)),
                    [169, 254, 3, 3] => Some(info("", 30)),
                    [10, 0, 0, 9] => Some(info("Hall", 90)),
                    _ => None,
                }
            },
        );

        let mut asked = asked.into_inner().unwrap();
        asked.sort();
        assert_eq!(
            asked,
            vec![
                Ipv4Addr::new(10, 0, 0, 9),
                Ipv4Addr::new(169, 254, 3, 3),
                Ipv4Addr::new(192, 168, 1, 40),
                Ipv4Addr::new(192, 168, 1, 41),
            ]
        );
        let found: Vec<_> = devices
            .iter()
            .map(|d| (d.ip.as_str(), d.name.as_deref(), d.led_count))
            .collect();
        // The advert's name stands in for a device that reports none.
        assert_eq!(
            found,
            vec![
                ("10.0.0.9", Some("Hall"), 90),
                ("169.254.3.3", Some("shelf"), 30),
                ("192.168.1.40", Some("Desk"), 60)
            ]
        );
        assert_eq!(devices[1].mac.as_deref(), Some("a0b1c2d3e4f5"));
    }

    #[test]
    fn a_browse_that_cannot_run_says_why_with_nothing_found() {
        let code = |error: MdnsBrowserError| browse_wled_with(|_| Err(error), |_| None).status.code;
        assert_eq!(
            code(MdnsBrowserError::Unsupported),
            "WLED_BROWSE_UNSUPPORTED"
        );
        assert_eq!(code(MdnsBrowserError::Poisoned), "WLED_BROWSE_FAILED");
        assert_eq!(
            code(MdnsBrowserError::BrowseFailed("rejected".into())),
            "WLED_BROWSE_FAILED"
        );
        let found = browse_wled_with(
            |_| Ok(vec![advert([192, 168, 1, 40], "desk")]),
            |_| Some(info("Desk", 60)),
        );
        assert_eq!(found.status.code, "WLED_BROWSE_OK");
        assert_eq!(found.devices.len(), 1);
    }
}
