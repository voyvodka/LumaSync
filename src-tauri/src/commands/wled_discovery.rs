/// WLED device discovery and sink connection commands.
///
/// v1.5 W1-B3: manual IP path only. mDNS auto-discovery is Wave 2 (W2-A3).
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
use std::net::Ipv4Addr;
use std::str::FromStr;
use std::time::Duration;

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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WledDeviceInfo {
    pub ip: String,
    pub mac: Option<String>,
    pub led_count: u16,
    pub name: Option<String>,
    pub version: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WledDiscoveryResponse {
    pub status: WledCommandStatus,
    pub device: Option<WledDeviceInfo>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WledConnectRequest {
    pub ip: String,
    pub port: Option<u16>,
    pub led_count: u16,
    pub protocol: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WledConnectResponse {
    pub status: WledCommandStatus,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WledTestRequest {
    pub ip: String,
    pub port: Option<u16>,
    pub led_count: u16,
    pub protocol: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WledTestResponse {
    pub status: WledCommandStatus,
    pub device: Option<WledDeviceInfo>,
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

fn parse_ipv4(ip: &str) -> Result<Ipv4Addr, String> {
    Ipv4Addr::from_str(ip)
        .map_err(|_| format!("WLED_INVALID_IP: '{}' is not a valid IPv4 address", ip))
}

fn fetch_wled_info(ip: &str) -> Result<WledInfoResponse, WledCommandStatus> {
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
        mac: if info.mac.is_empty() { None } else { Some(info.mac) },
        led_count: info.leds.count,
        name: if info.name.is_empty() { None } else { Some(info.name) },
        version: if info.ver.is_empty() { None } else { Some(info.ver) },
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
                device: Some(device),
            }
        }
        Err(status) => WledDiscoveryResponse {
            status,
            device: None,
        },
    }
}

#[tauri::command]
pub fn connect_wled_sink(
    request: WledConnectRequest,
    sink_registry: tauri::State<'_, ActiveSinkRegistry>,
) -> WledConnectResponse {
    let ip = match parse_ipv4(&request.ip) {
        Ok(addr) => addr,
        Err(msg) => {
            return WledConnectResponse {
                status: WledCommandStatus::err("WLED_INVALID_IP", &msg, None),
            }
        }
    };

    let protocol = parse_protocol(request.protocol.as_deref());
    let port = request.port.unwrap_or_else(|| default_port_for(protocol));

    let mut sink = WledUdpSink::new(ip, port, request.led_count, protocol);

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
    let info = match fetch_wled_info(&request.ip) {
        Ok(info) => info,
        Err(status) => return WledTestResponse { status, device: None },
    };

    if info.leds.count != request.led_count {
        let device = info_to_device(&request.ip, info);
        return WledTestResponse {
            status: WledCommandStatus::err(
                "WLED_LED_COUNT_MISMATCH",
                "Requested LED count does not match device-reported LED count.",
                Some(format!(
                    "requested={}, device={}",
                    request.led_count, device.led_count
                )),
            ),
            device: Some(device),
        };
    }

    let device = info_to_device(&request.ip, info);

    let ip = match parse_ipv4(&request.ip) {
        Ok(addr) => addr,
        Err(msg) => {
            return WledTestResponse {
                status: WledCommandStatus::err("WLED_INVALID_IP", &msg, None),
                device: Some(device),
            }
        }
    };

    let protocol = parse_protocol(request.protocol.as_deref());
    let port = request.port.unwrap_or_else(|| default_port_for(protocol));

    let mut sink = WledUdpSink::new(ip, port, request.led_count, protocol);

    if let Err(e) = sink.start() {
        return WledTestResponse {
            status: WledCommandStatus::err(
                "WLED_BRIDGE_UNREACHABLE",
                "Failed to bind UDP socket for test.",
                Some(e),
            ),
            device: Some(device),
        };
    }

    // Red ramp: LED i -> [i % 256, 0, 0]
    let frame: Vec<[u8; 3]> = (0..request.led_count as usize)
        .map(|i| [(i % 256) as u8, 0, 0])
        .collect();

    let send_result = sink.send_frame(&frame);
    let _ = sink.stop();

    match send_result {
        Ok(()) => WledTestResponse {
            status: WledCommandStatus::ok("WLED_TEST_OK", "Test frame (red ramp) sent successfully."),
            device: Some(device),
        },
        Err(e) => WledTestResponse {
            status: WledCommandStatus::err("WLED_TEST_SEND_FAILED", "Test frame send failed.", Some(e)),
            device: Some(device),
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
    fn info_to_device_maps_fields_correctly() {
        use super::{WledInfoResponse, WledLedsInfo, info_to_device};
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
        use super::{WledInfoResponse, WledLedsInfo, info_to_device};
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
