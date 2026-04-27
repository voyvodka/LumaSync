use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serialport::{available_ports, SerialPortType};

use super::device_handshake::{perform_handshake, HandshakeError, TimedSerialPort};
use super::led_output::{
    ColorCorrectionConfig, FirmwareProfile, LedChipType, LedOutputBridge, SerialSink,
};
use super::led_sink::LedSink;

const DEFAULT_CONNECT_BAUD_RATE: u32 = 115_200;
const DEFAULT_CONNECT_TIMEOUT_MS: u64 = 1_500;

/// Per-call read timeout on the serial port during the handshake round-trip.
/// Short enough that `TimedSerialPort` can poll tightly; the outer
/// `HANDSHAKE_ROUND_TRIP_TIMEOUT` governs the total window.
const HANDSHAKE_PORT_READ_TIMEOUT_MS: u64 = 50;

/// Total wall-clock budget for the PING → PONG round-trip.
///
/// Bumped from 1 000 ms to 2 000 ms to accommodate slower bootloaders and
/// older Nano variants. The post-open settle delay (`BOOTLOADER_SETTLE_DELAY_MS`)
/// consumes most of this window; the remaining budget covers the actual
/// round-trip which is typically < 5 ms on a healthy link.
const HANDSHAKE_ROUND_TRIP_TIMEOUT: Duration = Duration::from_millis(2_000);

/// Post-open settle delay before sending any bytes to the device.
///
/// Opening a serial port asserts DTR, which triggers the AVR auto-reset
/// circuit on Arduino-style boards (CH340, FTDI, CP2102, etc.). The
/// bootloader occupies the bus for ~1.5–2 s before jumping to the user
/// sketch. If LumaSync sends the PING handshake during this window the
/// bootloader ignores it and the sketch never sees it, causing a guaranteed
/// `SERIAL_HEALTH_HANDSHAKE_TIMEOUT`.
///
/// Fix: sleep this long after `open()` and before writing any frame bytes.
/// Both `connect_serial_port` and `run_serial_health_check` apply this delay.
///
/// Trade-off: every connect / health-check call now takes +2 s wall time.
/// This is acceptable — the alternative is a guaranteed handshake failure on
/// all Arduino-class hardware. A future improvement could suppress the reset
/// entirely by driving DTR low immediately after open
/// (`port.write_data_terminal_ready(false)` before any other byte), but that
/// path requires testing across all five supported chip families and is
/// deferred to a dedicated v1.5 follow-up item.
///
/// IMPORTANT: this delay is performed inside `tokio::task::spawn_blocking` so
/// the Tauri IPC dispatcher thread remains responsive while the serial port
/// settles. Running the sleep on the main IPC thread blocks every other
/// command (UI, telemetry, settings reads) for the full ~4 s window — a UX
/// regression observed on v1.5.0-rc where the entire app appeared frozen
/// during Run Health Check.
const BOOTLOADER_SETTLE_DELAY_MS: u64 = 2_000;

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
    /// Firmware profile **advertised by the device** in the PONG profile byte.
    ///
    /// Distinct from `ShellState.firmwareProfile` (user-selected encoder).
    /// The Settings UI compares the two so the dropdown can disable the
    /// incompatible option (Bug H4 — v1.5).
    /// Populated only on a successful handshake.
    pub advertised_firmware_profile: Option<FirmwareProfile>,
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
        // macOS exposes every USB serial device under both /dev/cu.* (call-out,
        // non-blocking, correct for data) and /dev/tty.* (blocking, requires DCD
        // signal that CH340/FTDI/CP2102 don't assert). The tty.* sibling is
        // meaningless for LumaSync — exposing it leads to false-positive pairing
        // where port open() succeeds but data flow silently fails (real incident
        // on 2026-04-26 where tty.* pairing produced "Connect and verify Pass"
        // followed by handshake timeout). Filter tty.* siblings out of
        // enumeration on macOS only; Linux and Windows are not affected.
        .filter(|p| !is_macos_tty_path(&p.port_name))
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

// ---------------------------------------------------------------------------
// connect_serial_port
//
// IMPORTANT: this command is `async fn` and routes the heavy serial I/O —
// `available_ports()`, `serialport::open()`, the AVR bootloader settle sleep
// (`BOOTLOADER_SETTLE_DELAY_MS`, ~2 s) — through `tokio::task::spawn_blocking`
// so it runs on the blocking pool. If those steps execute on the Tauri IPC
// dispatcher thread the entire app stalls for ~2 s on every connect attempt
// (every other command, every emit, every UI re-render queues behind the
// blocking sleep). This regression was reported by users on v1.5.0-rc as
// "Run Health Check freezes the app and the network panel for 4 seconds".
// ---------------------------------------------------------------------------

/// Internal outcome of the blocking portion of `connect_serial_port`.
///
/// Carried back from the worker thread to the async front so state mutation
/// (sink registry replace/clear, last-status update) happens on the runtime
/// side, keeping `Send` requirements clean.
enum ConnectOutcome {
    Connected {
        status: SerialConnectionStatus,
        sink: Box<dyn LedSink>,
    },
    Failed {
        status: SerialConnectionStatus,
        clear_sink: bool,
    },
}

#[tauri::command]
pub async fn connect_serial_port(
    port_name: String,
    chip_type: Option<LedChipType>,
    connection_state: tauri::State<'_, SerialConnectionState>,
    sink_registry: tauri::State<'_, ActiveSinkRegistry>,
) -> Result<SerialConnectionStatus, String> {
    let port_name_for_blocking = port_name.clone();
    let outcome = tokio::task::spawn_blocking(move || {
        connect_serial_port_blocking(port_name_for_blocking, chip_type)
    })
    .await
    .unwrap_or_else(|join_error| ConnectOutcome::Failed {
        status: SerialConnectionStatus {
            port_name: Some(port_name.clone()),
            connected: false,
            status: command_status(
                "CONNECT_FAILED",
                "Serial connect worker terminated unexpectedly.",
                Some(join_error.to_string()),
            ),
            updated_at_unix_ms: now_unix_ms(),
        },
        clear_sink: true,
    });

    let status = match outcome {
        ConnectOutcome::Connected { status, sink } => {
            sink_registry.replace(sink);
            status
        }
        ConnectOutcome::Failed { status, clear_sink } => {
            if clear_sink {
                sink_registry.clear();
            }
            status
        }
    };

    set_last_status(&connection_state, status.clone());
    // Always Ok — every failure path returns a populated `SerialConnectionStatus`
    // with `connected: false` and a coded `status.code`. The Result wrapper is
    // mandated by Tauri's async command + tauri::State lifetime constraint.
    Ok(status)
}

/// Synchronous core of `connect_serial_port`, run on the blocking pool.
///
/// Performs every operation that may block for a non-trivial amount of time:
///   - `available_ports()` (USB enumeration; up to ~50 ms on Windows).
///   - `serialport::new(...).open()` (driver call; can stall on permission).
///   - `BOOTLOADER_SETTLE_DELAY_MS` (~2 s std::thread::sleep).
///   - `SerialSink::with_chip_type(...)` (constant-time, but kept here for
///     locality so the returned `Box<dyn LedSink>` is built once and handed
///     back as a `Send` value).
fn connect_serial_port_blocking(
    port_name: String,
    chip_type: Option<LedChipType>,
) -> ConnectOutcome {
    let known_ports = match available_ports() {
        Ok(ports) => ports,
        Err(error) => {
            return ConnectOutcome::Failed {
                status: SerialConnectionStatus {
                    port_name: Some(port_name),
                    connected: false,
                    status: command_status(
                        "LIST_PORTS_FAILED",
                        "Connection check failed while reading available serial ports.",
                        Some(error.to_string()),
                    ),
                    updated_at_unix_ms: now_unix_ms(),
                },
                clear_sink: true,
            };
        }
    };

    let selected_port = known_ports
        .into_iter()
        .find(|port| port.port_name == port_name);

    let selected_port = match selected_port {
        Some(port) => port,
        None => {
            return ConnectOutcome::Failed {
                status: SerialConnectionStatus {
                    port_name: Some(port_name),
                    connected: false,
                    status: command_status(
                        "PORT_NOT_FOUND",
                        "Selected serial port is not available.",
                        None,
                    ),
                    updated_at_unix_ms: now_unix_ms(),
                },
                clear_sink: true,
            };
        }
    };

    if let SerialPortType::UsbPort(usb_info) = selected_port.port_type {
        if !is_supported_usb(usb_info.vid, usb_info.pid) {
            return ConnectOutcome::Failed {
                status: SerialConnectionStatus {
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
                },
                clear_sink: true,
            };
        }
    }

    let open_result = serialport::new(&port_name, DEFAULT_CONNECT_BAUD_RATE)
        .timeout(Duration::from_millis(DEFAULT_CONNECT_TIMEOUT_MS))
        .open();

    match open_result {
        Ok(_port_handle) => {
            // Wait for the AVR bootloader to finish before writing any bytes.
            // Opening the port asserts DTR which triggers auto-reset on
            // Arduino-class boards; the bootloader occupies the bus for
            // ~1.5–2 s. See `BOOTLOADER_SETTLE_DELAY_MS` for full rationale.
            //
            // SAFE: this runs on the tokio blocking pool, never on the IPC
            // dispatcher thread.
            std::thread::sleep(Duration::from_millis(BOOTLOADER_SETTLE_DELAY_MS));

            // Connection verified — build a SerialSink for this port and
            // hand it back to the async caller, which owns the registry.
            // The sink uses default profile (LumaSyncV1) and default
            // corrections; the user can change these via the Firmware Profile
            // setting (v1.4 G11) and color correction settings (v1.4 G4),
            // which will replace the sink.
            //
            // The ambilight worker (v1.4, W0-B1) creates its own SerialSink
            // independently. This registry entry is the hook for the v1.5
            // path where the worker will take() the pre-built sink from here.
            // Resolve chip type from caller (ShellState.selectedChipType).
            // Absent or None => WS2812B GRB (backward-compat default).
            let resolved_chip_type = chip_type.unwrap_or_default();
            let new_sink = SerialSink::with_chip_type(
                LedOutputBridge::new(),
                Some(port_name.clone()),
                1.0,
                FirmwareProfile::default(),
                ColorCorrectionConfig::default(),
                resolved_chip_type,
            );

            ConnectOutcome::Connected {
                status: SerialConnectionStatus {
                    port_name: Some(port_name),
                    connected: true,
                    status: command_status(
                        "CONNECT_OK",
                        "Serial port connection attempt succeeded.",
                        None,
                    ),
                    updated_at_unix_ms: now_unix_ms(),
                },
                sink: Box::new(new_sink),
            }
        }
        Err(error) => ConnectOutcome::Failed {
            status: SerialConnectionStatus {
                port_name: Some(port_name),
                connected: false,
                status: command_status(
                    connect_error_code(&error),
                    "Serial port connection attempt failed.",
                    Some(error.to_string()),
                ),
                updated_at_unix_ms: now_unix_ms(),
            },
            clear_sink: true,
        },
    }
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
///
/// IMPORTANT: this command is `async fn` and routes every blocking step
/// (`available_ports()`, `open()`, `BOOTLOADER_SETTLE_DELAY_MS` sleep, the
/// PING/PONG round-trip read) through `tokio::task::spawn_blocking` so the
/// Tauri IPC dispatcher stays free to service UI events, telemetry, and
/// other commands while the health check runs (~4 s end-to-end).
#[tauri::command]
pub async fn run_serial_health_check(port_name: String) -> HealthCheckResult {
    let result = tokio::task::spawn_blocking(move || run_serial_health_check_blocking(port_name))
        .await
        .unwrap_or_else(|join_error| HealthCheckResult {
            pass: false,
            steps: vec![HealthStepResult {
                step: "HEALTH_CHECK_WORKER".to_string(),
                pass: false,
                code: "SERIAL_HEALTH_WORKER_PANIC".to_string(),
                message: "Health check worker terminated unexpectedly.".to_string(),
                details: Some(join_error.to_string()),
            }],
            checked_at_unix_ms: now_unix_ms(),
            round_trip_ms: None,
            firmware_version: None,
            advertised_firmware_profile: None,
        });

    result
}

/// Synchronous core of `run_serial_health_check`, run on the blocking pool.
///
/// Performs the full 4-step probe (port enum → support gate → open + settle
/// → PING/PONG). Total wall time on a healthy Arduino-class link is
/// ~`BOOTLOADER_SETTLE_DELAY_MS` (~2 s) plus the round-trip read window.
fn run_serial_health_check_blocking(port_name: String) -> HealthCheckResult {
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
                advertised_firmware_profile: None,
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
                advertised_firmware_profile: None,
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
                    advertised_firmware_profile: None,
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
                advertised_firmware_profile: None,
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
            // Wait for the AVR bootloader to finish before sending PING.
            // Opening the port asserts DTR which triggers auto-reset on
            // Arduino-class boards; the bootloader occupies the bus for
            // ~1.5–2 s. See `BOOTLOADER_SETTLE_DELAY_MS` for full rationale.
            //
            // SAFE: this runs on the tokio blocking pool (see the wrapping
            // `run_serial_health_check` async command), never on the IPC
            // dispatcher thread.
            std::thread::sleep(Duration::from_millis(BOOTLOADER_SETTLE_DELAY_MS));
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
                advertised_firmware_profile: None,
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
                advertised_firmware_profile: Some(response.firmware_profile),
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
                advertised_firmware_profile: None,
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

/// Returns `true` for paths that should be suppressed from enumeration on macOS.
///
/// macOS exposes every USB serial adapter under two POSIX paths:
///   - `/dev/cu.*`  — call-out device, non-blocking, correct for outgoing data.
///   - `/dev/tty.*` — terminal device, blocking, requires DCD assertion.
///
/// CH340, FTDI FT232R, CP2102, and Arduino-class boards never assert DCD, so
/// the tty.* sibling opens at the file-descriptor level but silently stalls on
/// read/write once the kernel waits for the carrier-detect signal. This caused
/// a real incident on 2026-04-26 where pairing with `/dev/tty.usbserial-10`
/// produced "Connect and verify Pass" followed by a handshake timeout.
///
/// The filter covers ALL `/dev/tty.*` paths — including `/dev/tty.usbmodem*`
/// for genuine Arduinos — because the cu.* sibling is always present and is
/// the correct path. On Linux and Windows this function always returns `false`
/// (compile-time no-op), so their enumerators are unaffected.
#[cfg_attr(not(target_os = "macos"), allow(unused_variables))]
fn is_macos_tty_path(name: &str) -> bool {
    #[cfg(target_os = "macos")]
    {
        name.starts_with("/dev/tty.")
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
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
            "Handshake timed out: no response from firmware within 2 s.".to_string(),
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
    use std::collections::VecDeque;
    use std::time::Duration;

    use super::{is_macos_tty_path, is_supported_usb, HealthCheckResult, SUPPORTED_USB_DEVICE_ALLOWLIST};
    use super::super::device_handshake::{
        perform_handshake, SerialRoundTrip, FRAME_MAGIC, HANDSHAKE_OPCODE_PONG,
    };
    use super::super::led_output::FirmwareProfile;

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

    // ---------------------------------------------------------------------------
    // macOS tty.* filter — is_macos_tty_path
    //
    // On macOS the filter must suppress /dev/tty.* siblings while leaving
    // /dev/cu.* call-out paths, non-serial paths, and Windows/Linux COM paths
    // untouched. On non-macOS targets the function is a compile-time false
    // and all paths pass through unchanged.
    // ---------------------------------------------------------------------------

    #[test]
    fn macos_tty_usbserial_is_filtered() {
        // The exact path from the real incident on 2026-04-26.
        assert!(
            is_macos_tty_path("/dev/tty.usbserial-10"),
            "/dev/tty.usbserial-10 must be filtered on macOS"
        );
    }

    #[test]
    fn macos_tty_usbmodem_is_filtered() {
        // Arduino Uno via ATmega16U2 — tty.* sibling must also be suppressed.
        assert!(
            is_macos_tty_path("/dev/tty.usbmodem14201"),
            "/dev/tty.usbmodem* must be filtered on macOS"
        );
    }

    #[test]
    fn macos_cu_usbserial_passes_through() {
        assert!(
            !is_macos_tty_path("/dev/cu.usbserial-10"),
            "/dev/cu.usbserial-10 must NOT be filtered — it is the correct call-out path"
        );
    }

    #[test]
    fn macos_cu_usbmodem_passes_through() {
        assert!(
            !is_macos_tty_path("/dev/cu.usbmodem14201"),
            "/dev/cu.usbmodem* must NOT be filtered"
        );
    }

    #[test]
    fn macos_bluetooth_incoming_passes_through() {
        // Bluetooth virtual port — already gated by no VID/PID, but must not
        // be incorrectly caught by the tty filter either.
        assert!(
            !is_macos_tty_path("/dev/cu.Bluetooth-Incoming-Port"),
            "Bluetooth cu.* port must not be filtered"
        );
    }

    #[test]
    fn windows_com_port_passes_through() {
        // On non-macOS the function always returns false.
        assert!(
            !is_macos_tty_path("COM3"),
            "Windows COM3 must not be filtered on any platform"
        );
    }

    #[test]
    fn linux_ttyusb_passes_through() {
        // Linux uses /dev/ttyUSB0 — uppercase, no dot separator. Must not be
        // filtered even on macOS because it won't appear in macOS enumeration,
        // and on Linux the cfg guard ensures false.
        assert!(
            !is_macos_tty_path("/dev/ttyUSB0"),
            "/dev/ttyUSB0 must not be filtered — Linux path, no dot after tty"
        );
    }

    // ---------------------------------------------------------------------------
    // H4 — advertised_firmware_profile propagation from PONG into HealthCheckResult
    //
    // These tests verify that the Step 4 HANDSHAKE success arm correctly
    // propagates  into
    // , and that every error arm
    // (timeout and protocol error) leaves the field as .
    //
    //  is a local in-memory implementation of  that
    // mirrors the one in . Duplicated here to keep the
    // two test modules independently runnable without exposing test helpers as
    // .
    // ---------------------------------------------------------------------------

    /// Minimal in-memory serial port for handshake unit tests.
    struct MockPort {
        read_queue: VecDeque<u8>,
        written: Vec<u8>,
        silent: bool,
    }

    impl MockPort {
        fn with_response(response: Vec<u8>) -> Self {
            Self {
                read_queue: VecDeque::from(response),
                written: Vec::new(),
                silent: false,
            }
        }

        fn silent() -> Self {
            Self {
                read_queue: VecDeque::new(),
                written: Vec::new(),
                silent: true,
            }
        }
    }

    impl SerialRoundTrip for MockPort {
        fn write_all(&mut self, bytes: &[u8]) -> std::io::Result<()> {
            self.written.extend_from_slice(bytes);
            Ok(())
        }

        fn read_with_timeout(
            &mut self,
            buf: &mut [u8],
            _timeout: Duration,
        ) -> std::io::Result<usize> {
            if self.silent {
                return Ok(0);
            }
            let mut count = 0usize;
            for slot in buf.iter_mut() {
                match self.read_queue.pop_front() {
                    Some(b) => {
                        *slot = b;
                        count += 1;
                    }
                    None => break,
                }
            }
            Ok(count)
        }
    }

    /// Build a correctly checksummed 7-byte PONG frame.
    fn build_pong(fw_version: u16, profile_byte: u8) -> Vec<u8> {
        let ver = fw_version.to_le_bytes();
        let mut frame = vec![
            FRAME_MAGIC[0],
            FRAME_MAGIC[1],
            HANDSHAKE_OPCODE_PONG,
            ver[0],
            ver[1],
            profile_byte,
        ];
        let checksum = frame.iter().fold(0_u8, |acc, b| acc ^ b);
        frame.push(checksum);
        frame
    }

    /// Helper: build the  that the Step 4 success arm would
    /// produce, given the output of .
    fn make_health_result_from_pong(profile_byte: u8) -> HealthCheckResult {
        // 0x01 = LumaSyncV1, 0x02 = Adalight (wire constants from device_handshake)
        let pong = build_pong(0x0105, profile_byte);
        let mut port = MockPort::with_response(pong);

        match perform_handshake(&mut port, Duration::from_millis(1_000)) {
            Ok((response, elapsed_ms)) => HealthCheckResult {
                pass: true,
                steps: vec![],
                checked_at_unix_ms: 0,
                round_trip_ms: Some(elapsed_ms),
                firmware_version: Some(response.version_string()),
                advertised_firmware_profile: Some(response.firmware_profile),
            },
            Err(_) => HealthCheckResult {
                pass: false,
                steps: vec![],
                checked_at_unix_ms: 0,
                round_trip_ms: None,
                firmware_version: None,
                advertised_firmware_profile: None,
            },
        }
    }

    #[test]
    fn health_check_round_trips_advertised_lumasync_v1_profile_from_pong() {
        // profile byte 0x01 = LumaSyncV1
        let result = make_health_result_from_pong(0x01);
        assert_eq!(
            result.advertised_firmware_profile,
            Some(FirmwareProfile::LumaSyncV1),
            "PONG with profile byte 0x01 must propagate as LumaSyncV1"
        );
        assert!(result.pass, "success arm must set pass = true");
        assert!(result.firmware_version.is_some(), "firmware_version must be populated on success");
    }

    #[test]
    fn health_check_round_trips_advertised_adalight_profile_from_pong() {
        // profile byte 0x02 = Adalight
        let result = make_health_result_from_pong(0x02);
        assert_eq!(
            result.advertised_firmware_profile,
            Some(FirmwareProfile::Adalight),
            "PONG with profile byte 0x02 must propagate as Adalight"
        );
        assert!(result.pass, "success arm must set pass = true");
    }

    #[test]
    fn health_check_returns_none_advertised_profile_on_handshake_timeout() {
        // Silent port — simulates a device that never answers the PING
        // (non-LumaSync firmware, or unpowered strip).
        let mut port = MockPort::silent();
        let err_result = match perform_handshake(&mut port, Duration::from_millis(100)) {
            Ok((response, elapsed_ms)) => HealthCheckResult {
                pass: true,
                steps: vec![],
                checked_at_unix_ms: 0,
                round_trip_ms: Some(elapsed_ms),
                firmware_version: Some(response.version_string()),
                advertised_firmware_profile: Some(response.firmware_profile),
            },
            Err(_) => HealthCheckResult {
                pass: false,
                steps: vec![],
                checked_at_unix_ms: 0,
                round_trip_ms: None,
                firmware_version: None,
                advertised_firmware_profile: None,
            },
        };

        assert_eq!(
            err_result.advertised_firmware_profile,
            None,
            "handshake timeout must leave advertised_firmware_profile as None"
        );
        assert_eq!(err_result.round_trip_ms, None);
        assert!(!err_result.pass);
    }

    #[test]
    fn health_check_returns_none_advertised_profile_on_protocol_error() {
        // Garbled bytes — simulates a device that returns garbage on the bus
        // (e.g. non-LumaSync firmware echoing its own protocol).
        let garbled = vec![0xDE, 0xAD, 0xBE, 0xEF, 0x11, 0x22, 0x33];
        let mut port = MockPort::with_response(garbled);

        let err_result = match perform_handshake(&mut port, Duration::from_millis(1_000)) {
            Ok((response, elapsed_ms)) => HealthCheckResult {
                pass: true,
                steps: vec![],
                checked_at_unix_ms: 0,
                round_trip_ms: Some(elapsed_ms),
                firmware_version: Some(response.version_string()),
                advertised_firmware_profile: Some(response.firmware_profile),
            },
            Err(_) => HealthCheckResult {
                pass: false,
                steps: vec![],
                checked_at_unix_ms: 0,
                round_trip_ms: None,
                firmware_version: None,
                advertised_firmware_profile: None,
            },
        };

        assert_eq!(
            err_result.advertised_firmware_profile,
            None,
            "protocol error must leave advertised_firmware_profile as None"
        );
        assert_eq!(err_result.round_trip_ms, None);
        assert!(!err_result.pass);
    }
}