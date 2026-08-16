//! WLED device discovery and sink connection commands.
//!
//! v1.5 W1-B3: manual IP path only. mDNS auto-discovery is Wave 2 (W2-A3).
//! `WledDiscoveryResponse.devices` is a `Vec<WledDeviceInfo>` (not `Option<WledDeviceInfo>`)
//! so the frontend always gets a stable array — empty on failure, `[device]` on success.
//! This mirrors the Wave 2 mDNS path shape where multiple devices may appear.
//!
//! Status codes:
//!   WLED_DISCOVERY_OK          -- /json/info responded; device info parsed.
//!   WLED_DISCOVERY_TIMEOUT     -- HTTP request timed out (2 s).
//!   WLED_DISCOVERY_UNREACHABLE -- Connection refused / network error.
//!   WLED_PROTOCOL_MISMATCH     -- Response body is not valid WLED JSON.
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
use std::net::Ipv4Addr;
use std::str::FromStr;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use super::device_connection::ActiveSinkRegistry;
use super::led_sink::LedSink;
use super::wled_sink::{WledProtocol, WledSinkConfig, WledUdpSink};

const WLED_HTTP_TIMEOUT: Duration = Duration::from_secs(2);

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

/// Response from `discover_wled_devices`.
///
/// `devices` is always a stable Vec — empty on failure, `[device]` on a
/// successful single-IP probe. This shape already matches the Wave 2 mDNS
/// path (W2-A3) where multiple devices can appear in one response, so the
/// frontend array-rendering code needs no change at that migration point.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WledDiscoveryResponse {
    pub status: WledCommandStatus,
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
    pub status: WledCommandStatus,
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
    pub status: WledCommandStatus,
    pub send_latency_ms: Option<u64>,
    pub requested_led_count: Option<u16>,
    pub device_led_count: Option<u16>,
    pub device_realtime_port: Option<u16>,
}

impl WledTestResponse {
    fn failed(status: WledCommandStatus) -> Self {
        Self {
            status,
            send_latency_ms: None,
            requested_led_count: None,
            device_led_count: None,
            device_realtime_port: None,
        }
    }
}

/// The `WledSinkConfig` currently registered, in the frontend's
/// `WledUdpSinkConfig` shape.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WledSinkSnapshot {
    pub ip: String,
    pub port: u16,
    pub led_count: u16,
    pub protocol: String,
}

/// Response from `get_wled_sink_status`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WledSinkStatusResponse {
    pub connected: bool,
    pub sink: Option<WledSinkSnapshot>,
}

/// Coded status shared by every WLED command response.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WledCommandStatus {
    pub code: String,
    pub message: String,
    pub details: Option<String>,
}

impl WledCommandStatus {
    fn ok(code: &str, message: &str) -> Self {
        Self {
            code: code.to_string(),
            message: message.to_string(),
            details: None,
        }
    }

    fn err(code: &str, message: &str, details: Option<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.to_string(),
            details,
        }
    }
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

/// Inverse of `parse_protocol` — must stay in sync with the
/// `WledUdpSinkConfig["protocol"]` union in `src/shared/contracts/device.ts`.
fn protocol_to_str(protocol: WledProtocol) -> &'static str {
    match protocol {
        WledProtocol::Ddp => "ddp",
        WledProtocol::Drgb => "drgb",
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

fn fetch_wled_info(ip: &str) -> Result<WledInfoResponse, WledCommandStatus> {
    // SECURITY: Validate the input IP address to prevent SSRF vulnerabilities.
    // parse_ipv4 rejects loopback, unspecified, multicast, and broadcast in
    // addition to non-parseable strings.
    if let Err(msg) = parse_ipv4(ip) {
        return Err(WledCommandStatus::err(
            "WLED_INVALID_IP",
            "Invalid WLED device IP address format.",
            Some(msg),
        ));
    }

    let url = format!("http://{}/json/info", ip);

    let client = reqwest::blocking::Client::builder()
        .timeout(WLED_HTTP_TIMEOUT)
        .build()
        .map_err(|e| {
            WledCommandStatus::err(
                "WLED_CLIENT_BUILD_FAILED",
                "Failed to build HTTP client.",
                Some(e.to_string()),
            )
        })?;

    let response = client.get(&url).send().map_err(|e| {
        if e.is_timeout() {
            WledCommandStatus::err(
                "WLED_DISCOVERY_TIMEOUT",
                "WLED device did not respond within 2 seconds.",
                Some(format!("GET {} timed out", url)),
            )
        } else {
            WledCommandStatus::err(
                "WLED_DISCOVERY_UNREACHABLE",
                "Could not reach WLED device.",
                Some(e.to_string()),
            )
        }
    })?;

    if !response.status().is_success() {
        return Err(WledCommandStatus::err(
            "WLED_PROTOCOL_MISMATCH",
            "WLED device returned an unexpected HTTP status.",
            Some(format!("HTTP {}", response.status().as_u16())),
        ));
    }

    let info: WledInfoResponse = response.json().map_err(|e| {
        WledCommandStatus::err(
            "WLED_PROTOCOL_MISMATCH",
            "Response from device is not valid WLED JSON.",
            Some(e.to_string()),
        )
    })?;

    if info.leds.count == 0 {
        return Err(WledCommandStatus::err(
            "WLED_PROTOCOL_MISMATCH",
            "WLED /json/info response is missing leds.count.",
            None,
        ));
    }

    Ok(info)
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
            status: WledCommandStatus::err(
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
                status: WledCommandStatus::ok(
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

/// Build and register a `WledUdpSink` for the "usb" output channel,
/// evicting any previously connected serial or WLED sink.
#[tauri::command]
pub fn connect_wled_sink(
    request: WledConnectRequest,
    sink_registry: tauri::State<'_, ActiveSinkRegistry>,
) -> WledConnectResponse {
    let device = &request.device;

    // Guard: led_count == 0 is not a valid strip configuration.
    if device.led_count == 0 {
        return WledConnectResponse {
            status: WledCommandStatus::err(
                "WLED_INVALID_LED_COUNT",
                "LED count must be greater than zero.",
                None,
            ),
        };
    }

    let ip = match parse_ipv4(&device.ip) {
        Ok(addr) => addr,
        Err(msg) => {
            return WledConnectResponse {
                status: WledCommandStatus::err("WLED_INVALID_IP", &msg, None),
            }
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
        return WledConnectResponse {
            status: WledCommandStatus::err(
                "WLED_BRIDGE_UNREACHABLE",
                "Failed to bind UDP socket for WLED sink.",
                Some(e),
            ),
        };
    }

    // `sink` only proved the UDP socket could bind; `lighting_mode.rs`
    // rebuilds a fresh sink per mode-change from `config`, so it sees live
    // colour-correction settings (mirrors `SerialSink`'s rebuild-from-`port_name`).
    sink_registry.replace_wled(Box::new(sink), config);

    WledConnectResponse {
        status: WledCommandStatus::ok("WLED_CONNECT_OK", "WLED sink connected and registered."),
    }
}

/// Report the WLED sink currently bound to the "usb" output channel.
///
/// Reads `wled_config`, not `sink` — the stored trait object is decorative
/// (see `ActiveSinkRegistry`), and a serial connect clears the config, which
/// is exactly the eviction the frontend needs to observe.
#[tauri::command]
pub fn get_wled_sink_status(
    sink_registry: tauri::State<'_, ActiveSinkRegistry>,
) -> WledSinkStatusResponse {
    let config = sink_registry
        .wled_config
        .lock()
        .ok()
        .and_then(|guard| *guard);

    match config {
        Some(cfg) => WledSinkStatusResponse {
            connected: true,
            sink: Some(WledSinkSnapshot {
                ip: cfg.ip.to_string(),
                port: cfg.port,
                led_count: cfg.led_count,
                protocol: protocol_to_str(cfg.protocol).to_string(),
            }),
        },
        None => WledSinkStatusResponse {
            connected: false,
            sink: None,
        },
    }
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
            WledTestResponse::failed(WledCommandStatus::err(
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
            status: WledCommandStatus::err(
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
            return WledTestResponse::failed(WledCommandStatus::err("WLED_INVALID_IP", &msg, None))
        }
    };

    let protocol = parse_protocol(request.protocol.as_deref());
    let port = request.port.unwrap_or_else(|| default_port_for(protocol));

    // Fail closed on a port nothing listens on: the send would succeed at the
    // socket layer and the old code would have called that a pass. `udpport` 0
    // means the build did not report one, so it cannot contradict anything.
    if protocol == WledProtocol::Drgb && info.udpport != 0 && info.udpport != port {
        return WledTestResponse {
            status: WledCommandStatus::err(
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
        return WledTestResponse::failed(WledCommandStatus::err(
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
        return WledTestResponse::failed(WledCommandStatus::err(
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
        WledCommandStatus::ok(
            "WLED_TEST_LIVE_CONFIRMED",
            "Test frame sent and the device reported it is displaying a realtime source.",
        )
    } else {
        WledCommandStatus::ok(
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

    // Round-trips because the frontend persists what this emits and replays it
    // through `parse_protocol` on the next launch.
    #[test]
    fn protocol_to_str_round_trips_through_parse_protocol() {
        use super::protocol_to_str;
        for protocol in [WledProtocol::Ddp, WledProtocol::Drgb] {
            let encoded = protocol_to_str(protocol);
            assert_eq!(parse_protocol(Some(encoded)), protocol, "{encoded}");
        }
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

    #[test]
    fn wled_command_status_ok_has_no_details() {
        use super::WledCommandStatus;
        let s = WledCommandStatus::ok("WLED_DISCOVERY_OK", "found");
        assert_eq!(s.code, "WLED_DISCOVERY_OK");
        assert!(s.details.is_none());
    }

    #[test]
    fn wled_command_status_err_carries_details() {
        use super::WledCommandStatus;
        let s = WledCommandStatus::err(
            "WLED_DISCOVERY_TIMEOUT",
            "timed out",
            Some("2s".to_string()),
        );
        assert_eq!(s.code, "WLED_DISCOVERY_TIMEOUT");
        assert_eq!(s.details, Some("2s".to_string()));
    }
}
