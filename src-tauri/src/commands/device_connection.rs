use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serialport::{available_ports, SerialPortType};

use super::device_handshake::{perform_handshake, HandshakeError, TimedSerialPort};
use super::led_output::{ColorCorrectionConfig, FirmwareProfile, LedOutputBridge, SerialSink};
use super::led_sink::LedSink;

const DEFAULT_CONNECT_BAUD_RATE: u32 = 115_200;
const DEFAULT_CONNECT_TIMEOUT_MS: u64 = 1_500;

/// Per-call read timeout on the serial port during the handshake round-trip.
/// Short enough that `TimedSerialPort` can poll tightly; the outer
/// `HANDSHAKE_ROUND_TRIP_TIMEOUT` governs the total window.
const HANDSHAKE_PORT_READ_TIMEOUT_MS: u64 = 50;

/// Total wall-clock budget for the PING → PONG round-trip.
const HANDSHAKE_ROUND_TRIP_TIMEOUT: Duration = Duration::from_millis(1_000);

/// Supported USB serial adapter VID:PID allowlist.
///
/// Two-stage gate: all ports are enumerated with `isSupported: bool` so the
/// UI can show unsupported devices; connect is blocked with `PORT_UNSUPPORTED`
/// for entries not in this list.
///
/// v1.5 G5 additions: PL2303 (Prolific), CH341 (WinChipHead), CP2104 (Silicon
/// Labs), FT232H (FTDI Hi-Speed). Same array-addition pattern as the original
/// 5-entry list; no other changes required.
const SUPPORTED_USB_DEVICE_ALLOWLIST: &[(u16, u16)] = &[
    // --- original v1.x entries ---
    (0x1A86, 0x7523), // CH340 (WinChipHead)
    (0x0403, 0x6001), // FTDI FT232R
    (0x10C4, 0xEA60), // CP2102 (Silicon Labs)
    (0x2341, 0x0043), // Arduino Uno R3+
    (0x2341, 0x0001), // Arduino Uno (earlier USB ID)
    // --- v1.5 G5 additions ---
    (0x067B, 0x2303), // PL2303 (Prolific Technology)
    (0x1A86, 0x5523), // CH341 (WinChipHead)
    (0x10C4, 0xEA70), // CP2104 (Silicon Labs)
    (0x0403, 0x6014), // FT232H (FTDI Hi-Speed Single-Channel)
];

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandStatus {
    pub code: String,
    pub message: String,
    pub details: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsbPortMetadata {
    pub vid: u16,
    pub pid: u16,
    pub manufacturer: Option<String>,
    pub product: Option<String>,
    pub serial_number: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SerialPortDescriptor {
    pub name: String,
    pub kind: String,
    pub is_supported: bool,
    pub support_reason: String,
    pub usb: Option<UsbPortMetadata>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SerialPortListResponse {
    pub status: CommandStatus,
    pub ports: Vec<SerialPortDescriptor>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SerialConnectionStatus {
    pub port_name: Option<String>,
    pub connected: bool,
    pub status: CommandStatus,
    pub updated_at_unix_ms: u128,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthStepResult {
    pub step: String,
    pub pass: bool,
    pub code: String,
    pub message: String,
    pub details: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthCheckResult {
    pub pass: bool,
    pub steps: Vec<HealthStepResult>,
    pub checked_at_unix_ms: u128,
    /// Round-trip latency of the handshake in milliseconds.
    /// Populated only when the HANDSHAKE step completes successfully.
    pub round_trip_ms: Option<u32>,
    /// Firmware version string as reported by the device (e.g. `"1.4"`).
    /// Populated only on a successful handshake.
    pub firmware_version: Option<String>,
    /// Firmware profile advertised by the device.
    /// Populated only on a successful handshake.
    pub firmware_profile: Option<FirmwareProfile>,
}

pub struct SerialConnectionState {
    pub(crate) last_status: Mutex<SerialConnectionStatus>,
}

impl Default for SerialConnectionState {
    fn default() -> Self {
        Self {
            last_status: Mutex::new(SerialConnectionStatus {
                port_name: None,
                connected: false,
                status: command_status("NOT_CONNECTED", "No serial connection attempt yet.", None),
                updated_at_unix_ms: now_unix_ms(),
            }),
        }
    }
}

// ---------------------------------------------------------------------------
// ActiveSinkRegistry — persists the active `LedSink` handle across commands
//
// Populated by `connect_serial_port` on success. Cleared on disconnect or
// when a connection attempt fails. The ambilight worker (v1.4) creates its
// own `SerialSink` independently; this registry is the foundation for the
// v1.5 path where `start_ambilight_worker` will `take()` the pre-built sink
// from the registry instead of constructing one from scratch.
//
// Design:
//   - `Box<dyn LedSink>` keeps the registry type-erased so v1.5+ sinks
//     (WledUdpSink, OpenRgbClientSink) can be stored without changing the
//     registry type or any callers.
//   - `Mutex<Option<...>>` allows safe access from the Tauri command threads
//     without an async runtime.
//   - One active sink per registry instance (per output channel). Hue and
//     USB run as separate channels with separate state.
// ---------------------------------------------------------------------------

/// Tauri app state that holds the currently active `LedSink` handle.
///
/// `None` when no port is connected. Replaced on every successful
/// `connect_serial_port` call. The sink is stopped and cleared on
/// disconnect or failed connect.
pub struct ActiveSinkRegistry {
    pub sink: Mutex<Option<Box<dyn LedSink>>>,
}

impl Default for ActiveSinkRegistry {
    fn default() -> Self {
        Self {
            sink: Mutex::new(None),
        }
    }
}

impl ActiveSinkRegistry {
    /// Replace the stored sink with a new one.
    ///
    /// Stops the previous sink (if any) before replacing it, so the serial
    /// session is always released cleanly.
    pub fn replace(&self, new_sink: Box<dyn LedSink>) {
        if let Ok(mut guard) = self.sink.lock() {
            if let Some(mut old) = guard.take() {
                let _ = old.stop();
            }
            *guard = Some(new_sink);
        }
    }

    /// Remove and stop the stored sink.
    pub fn clear(&self) {
        if let Ok(mut guard) = self.sink.lock() {
            if let Some(mut old) = guard.take() {
                let _ = old.stop();
            }
        }
    }
}

#[tauri::command]
pub fn list_serial_ports() -> Result<SerialPortListResponse, String> {
    let ports = available_ports().map_err(|error| {
        format!("LIST_PORTS_FAILED: Could not enumerate serial ports ({error})")
    })?;

    let mapped_ports = ports
        .into_iter()
        .map(|port| {
            let name = port.port_name;

            match port.port_type {
                SerialPortType::UsbPort(usb_info) => {
                    let is_supported = is_supported_usb(usb_info.vid, usb_info.pid);
                    let support_reason = if is_supported {
                        "Supported USB serial adapter".to_string()
                    } else {
                        format!(
                            "Unsupported USB device (VID: {:04X}, PID: {:04X})",
                            usb_info.vid, usb_info.pid
                        )
                    };

                    SerialPortDescriptor {
                        name,
                        kind: "usb".to_string(),
                        is_supported,
                        support_reason,
                        usb: Some(UsbPortMetadata {
                            vid: usb_info.vid,
                            pid: usb_info.pid,
                            manufacturer: usb_info.manufacturer,
                            product: usb_info.product,
                            serial_number: usb_info.serial_number,
                        }),
                    }
                }
                SerialPortType::PciPort => SerialPortDescriptor {
                    name,
                    kind: "pci".to_string(),
                    is_supported: false,
                    support_reason: "Non-USB serial port (out of current support scope)"
                        .to_string(),
                    usb: None,
                },
                SerialPortType::BluetoothPort => SerialPortDescriptor {
                    name,
                    kind: "bluetooth".to_string(),
                    is_supported: false,
                    support_reason: "Bluetooth serial is not supported in this phase".to_string(),
                    usb: None,
                },
                SerialPortType::Unknown => SerialPortDescriptor {
                    name,
                    kind: "unknown".to_string(),
                    is_supported: false,
                    support_reason: "Unknown serial port type".to_string(),
                    usb: None,
                },
            }
        })
        .collect();

    Ok(SerialPortListResponse {
        status: command_status("LIST_PORTS_OK", "Serial ports listed successfully.", None),
        ports: mapped_ports,
    })
}

#[tauri::command]
pub fn connect_serial_port(
    port_name: String,
    connection_state: tauri::State<'_, SerialConnectionState>,
    sink_registry: tauri::State<'_, ActiveSinkRegistry>,
) -> SerialConnectionStatus {
    let known_ports = match available_ports() {
        Ok(ports) => ports,
        Err(error) => {
            sink_registry.clear();
            let result = SerialConnectionStatus {
                port_name: Some(port_name),
                connected: false,
                status: command_status(
                    "LIST_PORTS_FAILED",
                    "Connection check failed while reading available serial ports.",
                    Some(error.to_string()),
                ),
                updated_at_unix_ms: now_unix_ms(),
            };
            set_last_status(&connection_state, result.clone());
            return result;
        }
    };

    let selected_port = known_ports
        .into_iter()
        .find(|port| port.port_name == port_name);

    let selected_port = match selected_port {
        Some(port) => port,
        None => {
            sink_registry.clear();
            let result = SerialConnectionStatus {
                port_name: Some(port_name),
                connected: false,
                status: command_status(
                    "PORT_NOT_FOUND",
                    "Selected serial port is not available.",
                    None,
                ),
                updated_at_unix_ms: now_unix_ms(),
            };
            set_last_status(&connection_state, result.clone());
            return result;
        }
    };

    if let SerialPortType::UsbPort(usb_info) = selected_port.port_type {
        if !is_supported_usb(usb_info.vid, usb_info.pid) {
            sink_registry.clear();
            let result = SerialConnectionStatus {
                port_name: Some(port_name),
                connected: false,
                status: command_status(
                    "PORT_UNSUPPORTED",
                    "Selected USB serial adapter is not in the supported allowlist.",
                    Some(format!(
                        "VID={:04X}, PID={:04X}",
                        usb_info.vid, usb_info.pid
                    )),
                ),
                updated_at_unix_ms: now_unix_ms(),
            };
            set_last_status(&connection_state, result.clone());
            return result;
        }
    }

    let open_result = serialport::new(&port_name, DEFAULT_CONNECT_BAUD_RATE)
        .timeout(Duration::from_millis(DEFAULT_CONNECT_TIMEOUT_MS))
        .open();

    let result = match open_result {
        Ok(_port_handle) => {
            // Connection verified — build and register a SerialSink for this port.
            // The sink uses default profile (LumaSyncV1) and default corrections;
            // the user can change these via the Firmware Profile setting (v1.4 G11)
            // and color correction settings (v1.4 G4), which will replace the sink.
            //
            // The ambilight worker (v1.4, W0-B1) creates its own SerialSink
            // independently. This registry entry is the hook for the v1.5 path
            // where the worker will take() the pre-built sink from here.
            let new_sink = SerialSink::with_profile_and_corrections(
                LedOutputBridge::new(),
                Some(port_name.clone()),
                1.0,
                FirmwareProfile::default(),
                ColorCorrectionConfig::default(),
            );
            sink_registry.replace(Box::new(new_sink));

            SerialConnectionStatus {
                port_name: Some(port_name),
                connected: true,
                status: command_status(
                    "CONNECT_OK",
                    "Serial port connection attempt succeeded.",
                    None,
                ),
                updated_at_unix_ms: now_unix_ms(),
            }
        }
        Err(error) => {
            sink_registry.clear();
            SerialConnectionStatus {
                port_name: Some(port_name),
                connected: false,
                status: command_status(
                    connect_error_code(&error),
                    "Serial port connection attempt failed.",
                    Some(error.to_string()),
                ),
                updated_at_unix_ms: now_unix_ms(),
            }
        }
    };

    set_last_status(&connection_state, result.clone());
    result
}

#[tauri::command]
pub fn get_serial_connection_status(
    connection_state: tauri::State<'_, SerialConnectionState>,
) -> Result<SerialConnectionStatus, String> {
    connection_state
        .last_status
        .lock()
        .map(|status| status.clone())
        .map_err(|error| {
            format!("STATUS_READ_FAILED: Could not read serial connection status ({error})")
        })
}

/// Run a multi-step health check on `port_name`.
///
/// Steps:
/// 1. `PORT_VISIBLE`    — port appears in the OS serial inventory.
/// 2. `PORT_SUPPORTED`  — VID:PID matches the allowlist.
/// 3. `CONNECT_AND_VERIFY` — port can be opened at 115 200 baud.
/// 4. `HANDSHAKE`       — LumaSync v1 PING → PONG round-trip succeeded.
///    (v1.4: firmware companion not shipped yet — this step will report
///    `SERIAL_HEALTH_HANDSHAKE_TIMEOUT` when pointed at non-LumaSync firmware.
///    Real firmware integration arrives in v1.5.)
///
/// The command never throws; it always returns a `HealthCheckResult`.
#[tauri::command]
pub fn run_serial_health_check(port_name: String) -> HealthCheckResult {
    let mut steps = Vec::new();

    // -----------------------------------------------------------------------
    // Step 1: PORT_VISIBLE
    // -----------------------------------------------------------------------
    let ports = match available_ports() {
        Ok(ports) => ports,
        Err(error) => {
            steps.push(HealthStepResult {
                step: "PORT_VISIBLE".to_string(),
                pass: false,
                code: "LIST_PORTS_FAILED".to_string(),
                message: "Could not read serial ports for health check.".to_string(),
                details: Some(error.to_string()),
            });

            return HealthCheckResult {
                pass: false,
                steps,
                checked_at_unix_ms: now_unix_ms(),
                round_trip_ms: None,
                firmware_version: None,
                firmware_profile: None,
            };
        }
    };

    let selected_port = ports.into_iter().find(|port| port.port_name == port_name);
    let selected_port = match selected_port {
        Some(port) => {
            steps.push(HealthStepResult {
                step: "PORT_VISIBLE".to_string(),
                pass: true,
                code: "PORT_VISIBLE".to_string(),
                message: "Port is visible in serial inventory.".to_string(),
                details: None,
            });
            port
        }
        None => {
            steps.push(HealthStepResult {
                step: "PORT_VISIBLE".to_string(),
                pass: false,
                code: "PORT_NOT_FOUND".to_string(),
                message: "Selected serial port is not visible.".to_string(),
                details: Some("Refresh ports and verify cable connection.".to_string()),
            });

            return HealthCheckResult {
                pass: false,
                steps,
                checked_at_unix_ms: now_unix_ms(),
                round_trip_ms: None,
                firmware_version: None,
                firmware_profile: None,
            };
        }
    };

    // -----------------------------------------------------------------------
    // Step 2: PORT_SUPPORTED
    // -----------------------------------------------------------------------
    match selected_port.port_type {
        SerialPortType::UsbPort(usb_info) => {
            if is_supported_usb(usb_info.vid, usb_info.pid) {
                steps.push(HealthStepResult {
                    step: "PORT_SUPPORTED".to_string(),
                    pass: true,
                    code: "PORT_SUPPORTED".to_string(),
                    message: "Port matches supported USB adapter allowlist.".to_string(),
                    details: Some(format!(
                        "VID={:04X}, PID={:04X}",
                        usb_info.vid, usb_info.pid
                    )),
                });
            } else {
                steps.push(HealthStepResult {
                    step: "PORT_SUPPORTED".to_string(),
                    pass: false,
                    code: "PORT_UNSUPPORTED".to_string(),
                    message: "Port is visible but not in supported adapter allowlist.".to_string(),
                    details: Some(format!(
                        "VID={:04X}, PID={:04X}",
                        usb_info.vid, usb_info.pid
                    )),
                });

                return HealthCheckResult {
                    pass: false,
                    steps,
                    checked_at_unix_ms: now_unix_ms(),
                    round_trip_ms: None,
                    firmware_version: None,
                    firmware_profile: None,
                };
            }
        }
        _ => {
            steps.push(HealthStepResult {
                step: "PORT_SUPPORTED".to_string(),
                pass: false,
                code: "PORT_UNSUPPORTED".to_string(),
                message: "Only supported USB serial adapters are eligible.".to_string(),
                details: None,
            });

            return HealthCheckResult {
                pass: false,
                steps,
                checked_at_unix_ms: now_unix_ms(),
                round_trip_ms: None,
                firmware_version: None,
                firmware_profile: None,
            };
        }
    }

    // -----------------------------------------------------------------------
    // Step 3: CONNECT_AND_VERIFY — open the port
    // -----------------------------------------------------------------------
    let port_handle = match serialport::new(&port_name, DEFAULT_CONNECT_BAUD_RATE)
        .timeout(Duration::from_millis(HANDSHAKE_PORT_READ_TIMEOUT_MS))
        .open()
    {
        Ok(handle) => {
            steps.push(HealthStepResult {
                step: "CONNECT_AND_VERIFY".to_string(),
                pass: true,
                code: "CONNECT_OK".to_string(),
                message: "Port opened successfully at 115200 baud.".to_string(),
                details: None,
            });
            handle
        }
        Err(error) => {
            steps.push(HealthStepResult {
                step: "CONNECT_AND_VERIFY".to_string(),
                pass: false,
                code: connect_error_code(&error).to_string(),
                message: "Could not open serial port for health check.".to_string(),
                details: Some(error.to_string()),
            });

            return HealthCheckResult {
                pass: false,
                steps,
                checked_at_unix_ms: now_unix_ms(),
                round_trip_ms: None,
                firmware_version: None,
                firmware_profile: None,
            };
        }
    };

    // -----------------------------------------------------------------------
    // Step 4: HANDSHAKE — LumaSync v1 PING → PONG round-trip
    //
    // v1.4: firmware companion not yet shipped. Non-LumaSync firmware will
    // not respond to the PING, producing SERIAL_HEALTH_HANDSHAKE_TIMEOUT.
    // This is expected; the step is non-fatal (pass=false) so the UI can
    // surface an explanation without blocking the user from using the port
    // with the Adalight profile.
    // -----------------------------------------------------------------------
    let mut timed_port = TimedSerialPort::new(port_handle);
    let handshake_result = perform_handshake(&mut timed_port, HANDSHAKE_ROUND_TRIP_TIMEOUT);

    match handshake_result {
        Ok((response, elapsed_ms)) => {
            let version_str = response.version_string();
            steps.push(HealthStepResult {
                step: "HANDSHAKE".to_string(),
                pass: true,
                code: "SERIAL_HEALTH_OK".to_string(),
                message: format!(
                    "Handshake succeeded: firmware {} ({:?}), round-trip {}ms.",
                    version_str, response.firmware_profile, elapsed_ms
                ),
                details: Some(format!("round_trip_ms={elapsed_ms}")),
            });

            let pass = steps.iter().all(|s| s.pass);
            HealthCheckResult {
                pass,
                steps,
                checked_at_unix_ms: now_unix_ms(),
                round_trip_ms: Some(elapsed_ms),
                firmware_version: Some(version_str),
                firmware_profile: Some(response.firmware_profile),
            }
        }
        Err(err) => {
            let code = err.as_status_code();
            let (message, hint) = handshake_error_ui_message(&err);

            steps.push(HealthStepResult {
                step: "HANDSHAKE".to_string(),
                pass: false,
                code: code.to_string(),
                message,
                details: Some(hint),
            });

            // HANDSHAKE timeout/error is non-fatal at the result level — the port
            // is open and supported. The UI can still allow the user to proceed
            // with the Adalight profile. `pass` reflects all steps, so it will
            // be false here.
            let pass = steps.iter().all(|s| s.pass);
            HealthCheckResult {
                pass,
                steps,
                checked_at_unix_ms: now_unix_ms(),
                round_trip_ms: None,
                firmware_version: None,
                firmware_profile: None,
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

fn is_supported_usb(vid: u16, pid: u16) -> bool {
    SUPPORTED_USB_DEVICE_ALLOWLIST
        .iter()
        .any(|(allowed_vid, allowed_pid)| *allowed_vid == vid && *allowed_pid == pid)
}

fn connect_error_code(error: &serialport::Error) -> &'static str {
    match error.kind() {
        serialport::ErrorKind::NoDevice => "PORT_NOT_FOUND",
        serialport::ErrorKind::InvalidInput => "CONNECT_INVALID_INPUT",
        serialport::ErrorKind::Io(std::io::ErrorKind::PermissionDenied) => {
            "CONNECT_PERMISSION_DENIED"
        }
        serialport::ErrorKind::Io(std::io::ErrorKind::TimedOut) => "CONNECT_TIMEOUT",
        serialport::ErrorKind::Io(_) => "CONNECT_IO_ERROR",
        _ => "CONNECT_FAILED",
    }
}

/// Map a `HandshakeError` to a user-facing (message, hint) pair.
fn handshake_error_ui_message(err: &HandshakeError) -> (String, String) {
    match err {
        HandshakeError::TooShort => (
            "Handshake timed out: no response from firmware within 1 s.".to_string(),
            "If using non-LumaSync firmware, switch to the Adalight profile in Device settings."
                .to_string(),
        ),
        HandshakeError::BadMagic => (
            "Handshake failed: unexpected magic bytes in response.".to_string(),
            "Check baud rate and cable integrity. Non-LumaSync firmware will not respond to PING."
                .to_string(),
        ),
        HandshakeError::WrongOpcode => (
            "Handshake failed: wrong opcode in firmware response.".to_string(),
            "Firmware may be running an older protocol version.".to_string(),
        ),
        HandshakeError::BadChecksum => (
            "Handshake failed: checksum mismatch in PONG frame.".to_string(),
            "Possible cable noise or a firmware bug. Try a different USB cable.".to_string(),
        ),
        HandshakeError::UnknownProfile => (
            "Handshake failed: firmware advertised an unknown profile byte.".to_string(),
            "Upgrade firmware or select a compatible profile in Device settings.".to_string(),
        ),
    }
}

pub fn command_status(code: &str, message: &str, details: Option<String>) -> CommandStatus {
    CommandStatus {
        code: code.to_string(),
        message: message.to_string(),
        details,
    }
}

fn set_last_status(state: &SerialConnectionState, status: SerialConnectionStatus) {
    if let Ok(mut guard) = state.last_status.lock() {
        *guard = status;
    }
}

fn now_unix_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::{is_supported_usb, SUPPORTED_USB_DEVICE_ALLOWLIST};

    // ---------------------------------------------------------------------------
    // Original v1.x allowlist entries (regression)
    // ---------------------------------------------------------------------------

    #[test]
    fn ch340_is_supported() {
        assert!(
            is_supported_usb(0x1A86, 0x7523),
            "CH340 must be in allowlist"
        );
    }

    #[test]
    fn ftdi_ft232r_is_supported() {
        assert!(
            is_supported_usb(0x0403, 0x6001),
            "FTDI FT232R must be in allowlist"
        );
    }

    #[test]
    fn cp2102_is_supported() {
        assert!(
            is_supported_usb(0x10C4, 0xEA60),
            "CP2102 must be in allowlist"
        );
    }

    #[test]
    fn arduino_uno_r3_is_supported() {
        assert!(
            is_supported_usb(0x2341, 0x0043),
            "Arduino Uno R3+ must be in allowlist"
        );
    }

    #[test]
    fn arduino_uno_earlier_is_supported() {
        assert!(
            is_supported_usb(0x2341, 0x0001),
            "Arduino Uno (earlier) must be in allowlist"
        );
    }

    // ---------------------------------------------------------------------------
    // v1.5 G5 new entries
    // ---------------------------------------------------------------------------

    #[test]
    fn pl2303_is_supported() {
        assert!(
            is_supported_usb(0x067B, 0x2303),
            "PL2303 (Prolific) must be in v1.5 G5 allowlist"
        );
    }

    #[test]
    fn ch341_is_supported() {
        assert!(
            is_supported_usb(0x1A86, 0x5523),
            "CH341 (WinChipHead) must be in v1.5 G5 allowlist"
        );
    }

    #[test]
    fn cp2104_is_supported() {
        assert!(
            is_supported_usb(0x10C4, 0xEA70),
            "CP2104 (Silicon Labs) must be in v1.5 G5 allowlist"
        );
    }

    #[test]
    fn ft232h_is_supported() {
        assert!(
            is_supported_usb(0x0403, 0x6014),
            "FT232H (FTDI Hi-Speed) must be in v1.5 G5 allowlist"
        );
    }

    // ---------------------------------------------------------------------------
    // Non-allowlist device is rejected
    // ---------------------------------------------------------------------------

    #[test]
    fn unknown_vid_pid_is_not_supported() {
        assert!(
            !is_supported_usb(0xDEAD, 0xBEEF),
            "Unknown VID:PID must not be in allowlist"
        );
    }

    #[test]
    fn allowlist_has_nine_entries() {
        assert_eq!(
            SUPPORTED_USB_DEVICE_ALLOWLIST.len(),
            9,
            "Allowlist must contain exactly 9 entries (5 original + 4 v1.5 G5)"
        );
    }
}
