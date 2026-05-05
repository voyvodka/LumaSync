/// WLED device discovery and sink connection commands.
///
/// v1.5 W1-B3: manual IP path only. mDNS auto-discovery is Wave 2 (W2-A3).
/// `WledDiscoveryResponse.devices` is a `Vec<WledDeviceInfo>` (not `Option<WledDeviceInfo>`)
/// so the frontend always gets a stable array — empty on failure, `[device]` on success.
/// This mirrors the Wave 2 mDNS path shape where multiple devices may appear.
///
/// Status codes:
///   WLED_DISCOVERY_OK          -- /json/info responded; device info parsed.
///   WLED_DISCOVERY_TIMEOUT     -- HTTP request timed out (2 s).
///   WLED_DISCOVERY_UNREACHABLE -- Connection refused / network error.
///   WLED_PROTOCOL_MISMATCH     -- Response body is not valid WLED JSON.
///   WLED_LED_COUNT_MISMATCH    -- Requested ledCount != device-reported count.
///   WLED_BRIDGE_UNREACHABLE    -- connect/test: device not reachable.
///   WLED_CONNECT_OK            -- Sink built and registered.
///   WLED_TEST_OK               -- Test frame sent without error.
///   WLED_TEST_SEND_FAILED      -- Test frame UDP send failed.
///   WLED_INVALID_IP            -- IP failed SSRF guard (not IPv4, loopback,
///                                 unspecified, multicast, or broadcast).
///   WLED_INVALID_LED_COUNT     -- led_count == 0 supplied to connect_wled_sink.
use std::net::Ipv4Addr;
use std::str::FromStr;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use super::device_connection::ActiveSinkRegistry;
use super::led_sink::LedSink;
use super::wled_sink::{WledProtocol, WledUdpSink};

const WLED_HTTP_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WledDiscoveryRequest {
    pub ip: String,
}

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
/// `round_trip_ms` measures the wall-clock time from the UDP send call to
/// the moment it returns without error. This is a best-effort metric — it
/// does not include WLED's processing time, only the host-side send latency.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WledTestResponse {
    pub status: WledCommandStatus,
    pub round_trip_ms: Option<u64>,
}

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
}

#[derive(Debug, Default, Deserialize)]
struct WledLedsInfo {
    #[serde(default)]
    count: u16,
}

fn parse_protocol(s: Option<&str>) -> WledProtocol {
    match s {
        Some("warls") => WledProtocol::Warls,
        _ => WledProtocol::Ddp,
    }
}

fn default_port_for(protocol: WledProtocol) -> u16 {
    match protocol {
        WledProtocol::Ddp => 4048,
        WledProtocol::Warls => 21324,
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

#[tauri::command]
pub fn discover_wled_devices(request: WledDiscoveryRequest) -> WledDiscoveryResponse {
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

    let mut sink = WledUdpSink::new(ip, port, device.led_count, protocol);

    if let Err(e) = sink.start() {
        return WledConnectResponse {
            status: WledCommandStatus::err(
                "WLED_BRIDGE_UNREACHABLE",
                "Failed to bind UDP socket for WLED sink.",
                Some(e),
            ),
        };
    }

    sink_registry.replace(Box::new(sink));

    WledConnectResponse {
        status: WledCommandStatus::ok("WLED_CONNECT_OK", "WLED sink connected and registered."),
    }
}

#[tauri::command]
pub fn test_wled_bridge(request: WledTestRequest) -> WledTestResponse {
    let device = &request.device;

    let info = match fetch_wled_info(&device.ip) {
        Ok(info) => info,
        Err(status) => {
            return WledTestResponse {
                status,
                round_trip_ms: None,
            }
        }
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
            round_trip_ms: None,
        };
    }

    let ip = match parse_ipv4(&device.ip) {
        Ok(addr) => addr,
        Err(msg) => {
            return WledTestResponse {
                status: WledCommandStatus::err("WLED_INVALID_IP", &msg, None),
                round_trip_ms: None,
            }
        }
    };

    let protocol = parse_protocol(request.protocol.as_deref());
    let port = request.port.unwrap_or_else(|| default_port_for(protocol));

    let mut sink = WledUdpSink::new(ip, port, device.led_count, protocol);

    if let Err(e) = sink.start() {
        return WledTestResponse {
            status: WledCommandStatus::err(
                "WLED_BRIDGE_UNREACHABLE",
                "Failed to bind UDP socket for test.",
                Some(e),
            ),
            round_trip_ms: None,
        };
    }

    // Red ramp: LED i -> [i % 256, 0, 0]
    let frame: Vec<[u8; 3]> = (0..device.led_count as usize)
        .map(|i| [(i % 256) as u8, 0, 0])
        .collect();

    let t0 = Instant::now();
    let send_result = sink.send_frame(&frame);
    let elapsed_ms = t0.elapsed().as_millis() as u64;
    let _ = sink.stop();

    match send_result {
        Ok(()) => WledTestResponse {
            status: WledCommandStatus::ok(
                "WLED_TEST_OK",
                "Test frame (red ramp) sent successfully.",
            ),
            round_trip_ms: Some(elapsed_ms),
        },
        Err(e) => WledTestResponse {
            status: WledCommandStatus::err(
                "WLED_TEST_SEND_FAILED",
                "Test frame send failed.",
                Some(e),
            ),
            round_trip_ms: None,
        },
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
    fn parse_protocol_warls() {
        assert_eq!(parse_protocol(Some("warls")), WledProtocol::Warls);
    }

    #[test]
    fn default_port_ddp_is_4048() {
        assert_eq!(default_port_for(WledProtocol::Ddp), 4048);
    }

    #[test]
    fn default_port_warls_is_21324() {
        assert_eq!(default_port_for(WledProtocol::Warls), 21324);
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
