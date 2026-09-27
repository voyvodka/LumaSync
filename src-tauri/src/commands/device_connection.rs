//! USB serial port enumeration, the connect and health-check commands, and the serial port watcher.
//! What is connected lives in `local_outputs::LocalOutputRegistry`.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serialport::{available_ports, SerialPortInfo, SerialPortType};

use super::device_handshake::{
    perform_handshake, probe_firmware, FirmwareProbe, HandshakeError, HandshakePongResponse,
    SerialRoundTrip, TimedSerialPort, MAX_FW_MAJOR,
};
use super::led_output::{FirmwareProfile, LedChipType, WirePixelLayout};
use super::local_outputs::{self, LocalOutputRegistry};
use super::status::CommandStatus;

const DEFAULT_CONNECT_BAUD_RATE: u32 = 115_200;

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

/// The connect-time PING's window. Short because every silent device — every
/// Adalight sketch — pays it on every connect; a LumaSync firmware answers in
/// about 12 ms once the settle is over.
const CONNECT_HANDSHAKE_TIMEOUT: Duration = Duration::from_millis(250);

/// Post-open settle delay before sending any bytes to the device — a PING
/// sent before the bootloader window closes is a guaranteed
/// `SERIAL_HEALTH_HANDSHAKE_TIMEOUT`. Must run inside `tokio::task::spawn_blocking`,
/// never on the IPC dispatcher thread. See docs/architecture/device-output.md.
pub(crate) const BOOTLOADER_SETTLE_DELAY_MS: u64 = 2_000;

/// Supported USB serial adapter VID:PID allowlist — read this constant,
/// never hardcode elsewhere. See docs/architecture/device-output.md for why
/// an unrecognized port is refused rather than opened.
const SUPPORTED_USB_DEVICE_ALLOWLIST: &[(u16, u16)] = &[
    // --- original v1.x entries ---
    (0x1A86, 0x7523), // CH340 (WinChipHead)
    (0x0403, 0x6001), // FTDI FT232R
    (0x10C4, 0xEA60), // CP2102 (Silicon Labs)
    (0x2341, 0x0043), // Arduino Uno R3+
    (0x2341, 0x0001), // Arduino Uno (earlier USB ID)
    // --- added after the first five ---
    (0x067B, 0x2303), // PL2303 (Prolific Technology)
    (0x1A86, 0x5523), // CH341 (WinChipHead)
    (0x10C4, 0xEA70), // CP2104 (Silicon Labs)
    (0x0403, 0x6014), // FT232H (FTDI Hi-Speed Single-Channel)
];

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsbPortMetadata {
    pub vid: u16,
    pub pid: u16,
    pub manufacturer: Option<String>,
    pub product: Option<String>,
    pub serial_number: Option<String>,
}

/// One enumerated serial port plus whether it matches the supported USB
/// adapter allowlist.
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

/// A PONG the host accepted, as the frontend sees it. Advisory: nothing on the
/// host switches profile or chip type from it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SerialFirmwareInfo {
    pub version: String,
    pub version_raw: u16,
    pub profile: FirmwareProfile,
    pub pixel_layout: WirePixelLayout,
}

impl SerialFirmwareInfo {
    fn from_pong(pong: &HandshakePongResponse) -> Self {
        Self {
            version: pong.version_string(),
            version_raw: pong.firmware_version,
            profile: pong.firmware_profile,
            pixel_layout: pong.pixel_layout,
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SerialConnectionStatus {
    /// The port that was opened — `Some` exactly when `connected` is true.
    pub port_name: Option<String>,
    pub connected: bool,
    pub status: CommandStatus,
    pub updated_at_unix_ms: u128,
    /// The PONG answered to the connect-time PING. `None` for a device that
    /// stayed silent or answered garbage, which still connects.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub firmware: Option<SerialFirmwareInfo>,
}

impl SerialConnectionStatus {
    /// The port serial output may be written to: the recorded one, and only
    /// while connected.
    pub fn output_port(&self) -> Option<&str> {
        self.port_name.as_deref().filter(|_| self.connected)
    }
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

/// Full outcome of `run_serial_health_check`: pass/fail per step, plus
/// round-trip and firmware metadata on a successful handshake.
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
    /// The whole accepted PONG, pixel layout included.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub firmware: Option<SerialFirmwareInfo>,
}

impl HealthCheckResult {
    /// A check that stopped at the last of `steps`, with no handshake data.
    fn failed(steps: Vec<HealthStepResult>) -> Self {
        Self {
            pass: false,
            steps,
            checked_at_unix_ms: now_unix_ms(),
            round_trip_ms: None,
            firmware_version: None,
            advertised_firmware_profile: None,
            firmware: None,
        }
    }
}

/// List every serial port the OS can see, flagging which ones match the
/// supported USB adapter allowlist.
// Off the main thread: enumeration walks the OS device tree and can stall.
#[tauri::command]
pub async fn list_serial_ports<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<SerialPortListResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        list_serial_ports_blocking(&app.state::<SerialPortAccess>())
    })
    .await
    .unwrap_or_else(|error| {
        Err(format!(
            "LIST_PORTS_FAILED: Serial port enumeration did not complete ({error})"
        ))
    })
}

fn list_serial_ports_blocking(
    port_access: &SerialPortAccess,
) -> Result<SerialPortListResponse, String> {
    let ports = port_access.available_ports().map_err(|error| {
        format!("LIST_PORTS_FAILED: Could not enumerate serial ports ({error})")
    })?;

    Ok(SerialPortListResponse {
        status: command_status("LIST_PORTS_OK", "Serial ports listed successfully.", None),
        ports: listed_ports(ports),
    })
}

/// The ports the UI is shown, each flagged against the allowlist. Connect and
/// the health check reach `open()` only through `admit_port`, which reads this
/// same listing, so nothing is opened that the list would not offer.
fn listed_ports(ports: Vec<SerialPortInfo>) -> Vec<SerialPortDescriptor> {
    ports
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
        .map(describe_port)
        .collect()
}

fn describe_port(port: SerialPortInfo) -> SerialPortDescriptor {
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
            support_reason: "Non-USB serial port (out of current support scope)".to_string(),
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
}

/// Why `admit_port` refused a name. The variant only chooses the message; the
/// code is `PORT_NOT_FOUND` or `PORT_UNSUPPORTED`.
#[derive(Debug, PartialEq, Eq)]
enum PortRefusal {
    NotFound,
    /// The macOS `/dev/tty.*` sibling of a call-out device: it opens, then
    /// stalls on DCD. Carries the `/dev/cu.*` path that works.
    MacosTtySibling {
        call_out: String,
    },
    UnsupportedUsb {
        vid: u16,
        pid: u16,
    },
    /// Bluetooth, PCI, or an unknown port type.
    NotUsb,
}

impl PortRefusal {
    fn code(&self) -> &'static str {
        match self {
            PortRefusal::NotFound => "PORT_NOT_FOUND",
            _ => "PORT_UNSUPPORTED",
        }
    }
}

/// Admits `port_name` only when `listed_ports` shows it as supported. This is
/// the one gate between a name — picked, persisted as `lastSuccessfulPort`, or
/// sent over IPC directly — and `open()`.
fn admit_port(
    ports: Vec<SerialPortInfo>,
    port_name: &str,
) -> Result<SerialPortDescriptor, PortRefusal> {
    if is_macos_tty_path(port_name) {
        let enumerated = ports.iter().any(|port| port.port_name == port_name);
        return Err(if enumerated {
            PortRefusal::MacosTtySibling {
                call_out: port_name.replacen("/dev/tty.", "/dev/cu.", 1),
            }
        } else {
            PortRefusal::NotFound
        });
    }

    let descriptor = listed_ports(ports)
        .into_iter()
        .find(|port| port.name == port_name)
        .ok_or(PortRefusal::NotFound)?;

    if descriptor.is_supported {
        return Ok(descriptor);
    }
    Err(match descriptor.usb {
        Some(usb) => PortRefusal::UnsupportedUsb {
            vid: usb.vid,
            pid: usb.pid,
        },
        None => PortRefusal::NotUsb,
    })
}

/// A settled port handle, handed back for the PING/PONG round-trip.
pub type SettledPort = Box<dyn SerialRoundTrip + Send>;

/// Enumeration and the open behind connect and the health check, behind a
/// seam so the IPC tests can drive `admit_port` with a synthetic inventory,
/// see whether `open()` was ever reached, and script what the device answers.
/// Production uses `SystemSerialPortIo`.
pub trait SerialPortIo: Send + Sync {
    fn available_ports(&self) -> serialport::Result<Vec<SerialPortInfo>>;
    /// Opens `port_name` at the connect baud and waits out the bootloader.
    /// The handshake runs on the returned handle: reopening would assert DTR
    /// and reset the board again. Blocks for ~2 s; call it on the blocking pool.
    fn open_and_settle(&self, port_name: &str) -> serialport::Result<SettledPort>;
}

struct SystemSerialPortIo;

impl SerialPortIo for SystemSerialPortIo {
    fn available_ports(&self) -> serialport::Result<Vec<SerialPortInfo>> {
        available_ports()
    }

    fn open_and_settle(&self, port_name: &str) -> serialport::Result<SettledPort> {
        // A short per-read timeout: `TimedSerialPort` polls against its own
        // round-trip deadline, which a long one would overrun.
        let port = serialport::new(port_name, DEFAULT_CONNECT_BAUD_RATE)
            .timeout(Duration::from_millis(HANDSHAKE_PORT_READ_TIMEOUT_MS))
            .open()?;
        // Opening asserts DTR, which auto-resets Arduino-class boards; the
        // bootloader owns the bus for ~1.5–2 s. See `BOOTLOADER_SETTLE_DELAY_MS`.
        std::thread::sleep(Duration::from_millis(BOOTLOADER_SETTLE_DELAY_MS));
        Ok(Box::new(TimedSerialPort::new(port)))
    }
}

/// Tauri-managed serial port inventory behind listing and connect.
#[derive(Clone)]
pub struct SerialPortAccess {
    io: Arc<dyn SerialPortIo>,
}

impl Default for SerialPortAccess {
    fn default() -> Self {
        Self {
            io: Arc::new(SystemSerialPortIo),
        }
    }
}

impl SerialPortAccess {
    #[cfg(test)]
    pub fn from_io(io: Arc<dyn SerialPortIo>) -> Self {
        Self { io }
    }

    fn available_ports(&self) -> serialport::Result<Vec<SerialPortInfo>> {
        self.io.available_ports()
    }

    fn io(&self) -> Arc<dyn SerialPortIo> {
        Arc::clone(&self.io)
    }
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
/// Carried back from the worker thread to the async front, where the registry is written.
enum ConnectOutcome {
    Connected {
        status: SerialConnectionStatus,
    },
    Failed {
        status: SerialConnectionStatus,
        /// The port passed admission. A refused name is never recorded: it came straight from IPC.
        admitted: bool,
    },
}

/// Open the given serial port, run the bootloader settle delay and probe the firmware. The output
/// path builds its own sink from live settings, so `chip_type` is accepted for the contract and
/// otherwise unused.
#[tauri::command]
pub async fn connect_serial_port<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    port_name: String,
    chip_type: Option<LedChipType>,
    registry: tauri::State<'_, LocalOutputRegistry>,
    port_access: tauri::State<'_, SerialPortAccess>,
) -> Result<SerialConnectionStatus, String> {
    let _ = chip_type;
    let port_name_for_blocking = port_name.clone();
    let io = port_access.io();
    let outcome = tokio::task::spawn_blocking(move || {
        connect_serial_port_blocking(io.as_ref(), port_name_for_blocking)
    })
    .await
    .unwrap_or_else(|join_error| ConnectOutcome::Failed {
        status: failed_connect_status(
            &port_name,
            "CONNECT_FAILED",
            "Serial connect worker terminated unexpectedly.",
            Some(join_error.to_string()),
        ),
        admitted: false,
    });

    let (status, snapshot) = match outcome {
        ConnectOutcome::Connected { status } => {
            let snapshot = registry.serial_connected(status.clone());
            (status, snapshot)
        }
        ConnectOutcome::Failed { status, admitted } => {
            let admitted_port = admitted.then_some(port_name.as_str());
            let snapshot = registry.serial_failed(admitted_port, status.clone());
            (status, snapshot)
        }
    };
    local_outputs::announce(&app, snapshot);
    if status.connected {
        super::lighting_mode::outputs::note_local_sink_connected(&app);
    }
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
///   - the PING/PONG firmware probe.
fn connect_serial_port_blocking(io: &dyn SerialPortIo, port_name: String) -> ConnectOutcome {
    let known_ports = match io.available_ports() {
        Ok(ports) => ports,
        Err(error) => {
            return ConnectOutcome::Failed {
                status: failed_connect_status(
                    &port_name,
                    "LIST_PORTS_FAILED",
                    "Connection check failed while reading available serial ports.",
                    Some(error.to_string()),
                ),
                admitted: false,
            };
        }
    };

    // Reject non-USB serial ports up-front — macOS phantom endpoints accept
    // open()/write() and go nowhere. See docs/architecture/device-output.md.
    if let Err(refusal) = admit_port(known_ports, &port_name) {
        let (message, details) = match &refusal {
            PortRefusal::NotFound => ("Selected serial port is not available.", None),
            PortRefusal::MacosTtySibling { call_out } => (
                "macOS /dev/tty.* serial paths wait on a carrier signal USB adapters never raise; use the /dev/cu.* path.",
                Some(format!("use {call_out:?}")),
            ),
            PortRefusal::UnsupportedUsb { vid, pid } => (
                "Selected USB serial adapter is not in the supported allowlist.",
                Some(format!("VID={vid:04X}, PID={pid:04X}")),
            ),
            PortRefusal::NotUsb => (
                "Only USB serial adapters are supported (Bluetooth and PCI serial ports cannot drive LED strips).",
                None,
            ),
        };
        return ConnectOutcome::Failed {
            status: failed_connect_status(&port_name, refusal.code(), message, details),
            admitted: false,
        };
    }

    match io.open_and_settle(&port_name) {
        Ok(mut handle) => {
            let probe = probe_firmware(handle.as_mut(), CONNECT_HANDSHAKE_TIMEOUT);
            // Released before connect returns; the output path opens its own
            // handle and settles again. See docs/architecture/device-output.md.
            drop(handle);
            let (firmware, details) = connect_firmware_outcome(&port_name, &probe);

            ConnectOutcome::Connected {
                status: SerialConnectionStatus {
                    port_name: Some(port_name),
                    connected: true,
                    status: command_status(
                        "CONNECT_OK",
                        "Serial port connection attempt succeeded.",
                        details,
                    ),
                    updated_at_unix_ms: now_unix_ms(),
                    firmware,
                },
            }
        }
        Err(error) => ConnectOutcome::Failed {
            status: failed_connect_status(
                &port_name,
                connect_error_code(&error),
                "Serial port connection attempt failed.",
                Some(error.to_string()),
            ),
            admitted: true,
        },
    }
}

/// What connect reports about its probe. A silent or garbled device connects
/// exactly as it did before the probe existed: no firmware, no details.
fn connect_firmware_outcome(
    port_name: &str,
    probe: &FirmwareProbe,
) -> (Option<SerialFirmwareInfo>, Option<String>) {
    match probe {
        FirmwareProbe::Answered(pong) => {
            log::info!(
                "[connect_serial_port] firmware answered on {port_name}: v{} profile={:?} layout={:?}",
                pong.version_string(),
                pong.firmware_profile,
                pong.pixel_layout
            );
            let details = version_window_warning(pong);
            if let Some(warning) = &details {
                log::warn!("[connect_serial_port] {warning}");
            }
            (Some(SerialFirmwareInfo::from_pong(pong)), details)
        }
        FirmwareProbe::Silent => {
            log::info!(
                "[connect_serial_port] no PONG from {port_name} within {}ms — unknown firmware \
                 (Adalight or a pre-handshake sketch); connected without firmware info",
                CONNECT_HANDSHAKE_TIMEOUT.as_millis()
            );
            (None, None)
        }
        FirmwareProbe::Garbled(error) => {
            log::info!(
                "[connect_serial_port] unreadable reply from {port_name} ({error:?}) — unknown \
                 firmware; connected without firmware info"
            );
            (None, None)
        }
    }
}

/// `SERIAL_HEALTH_VERSION_MISMATCH` text for a PONG outside the host's window,
/// or `None` inside it. Streaming carries on either way.
fn version_window_warning(pong: &HandshakePongResponse) -> Option<String> {
    (!pong.is_version_supported()).then(|| {
        format!(
            "SERIAL_HEALTH_VERSION_MISMATCH: firmware {} is outside the 1.0–{MAX_FW_MAJOR}.x \
             versions this app knows; streaming LumaSync v1 frames anyway.",
            pong.version_string()
        )
    })
}

/// Run a multi-step health check on `port_name`.
///
/// Steps:
/// 1. `PORT_VISIBLE`    — port appears in the OS serial inventory.
/// 2. `PORT_SUPPORTED`  — VID:PID matches the allowlist.
/// 3. `CONNECT_AND_VERIFY` — port can be opened at 115 200 baud.
/// 4. `HANDSHAKE`       — LumaSync v1 PING → PONG round-trip succeeded.
///    Firmware that does not speak it (Adalight, older sketches) fails this step.
///
/// The command never throws; it always returns a `HealthCheckResult`.
///
/// IMPORTANT: this command is `async fn` and routes every blocking step
/// (`available_ports()`, `open()`, `BOOTLOADER_SETTLE_DELAY_MS` sleep, the
/// PING/PONG round-trip read) through `tokio::task::spawn_blocking` so the
/// Tauri IPC dispatcher stays free to service UI events, telemetry, and
/// other commands while the health check runs (~4 s end-to-end).
#[tauri::command]
pub async fn run_serial_health_check<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    port_name: String,
) -> HealthCheckResult {
    tokio::task::spawn_blocking(move || {
        use tauri::Manager;
        let io = app.state::<SerialPortAccess>().io();
        run_serial_health_check_blocking(io.as_ref(), port_name)
    })
    .await
    .unwrap_or_else(|join_error| {
        HealthCheckResult::failed(vec![HealthStepResult {
            step: "HEALTH_CHECK_WORKER".to_string(),
            pass: false,
            code: "SERIAL_HEALTH_WORKER_PANIC".to_string(),
            message: "Health check worker terminated unexpectedly.".to_string(),
            details: Some(join_error.to_string()),
        }])
    })
}

/// Synchronous core of `run_serial_health_check`, run on the blocking pool.
///
/// Performs the full 4-step probe (port enum → support gate → open + settle
/// → PING/PONG). Total wall time on a healthy Arduino-class link is
/// ~`BOOTLOADER_SETTLE_DELAY_MS` (~2 s) plus the round-trip read window.
fn run_serial_health_check_blocking(io: &dyn SerialPortIo, port_name: String) -> HealthCheckResult {
    let mut steps = Vec::new();

    // -----------------------------------------------------------------------
    // Step 1: PORT_VISIBLE
    // -----------------------------------------------------------------------
    let ports = match io.available_ports() {
        Ok(ports) => ports,
        Err(error) => {
            steps.push(HealthStepResult {
                step: "PORT_VISIBLE".to_string(),
                pass: false,
                code: "LIST_PORTS_FAILED".to_string(),
                message: "Could not read serial ports for health check.".to_string(),
                details: Some(error.to_string()),
            });
            return HealthCheckResult::failed(steps);
        }
    };

    // Same gate as connect: a name the listing would not offer as supported
    // (including a macOS `/dev/tty.*` sibling) is never opened.
    let admission = admit_port(ports, &port_name);
    if matches!(admission, Err(PortRefusal::NotFound)) {
        steps.push(HealthStepResult {
            step: "PORT_VISIBLE".to_string(),
            pass: false,
            code: "PORT_NOT_FOUND".to_string(),
            message: "Selected serial port is not visible.".to_string(),
            details: Some("Refresh ports and verify cable connection.".to_string()),
        });
        return HealthCheckResult::failed(steps);
    }
    steps.push(HealthStepResult {
        step: "PORT_VISIBLE".to_string(),
        pass: true,
        code: "PORT_VISIBLE".to_string(),
        message: "Port is visible in serial inventory.".to_string(),
        details: None,
    });

    // -----------------------------------------------------------------------
    // Step 2: PORT_SUPPORTED
    // -----------------------------------------------------------------------
    let refusal = match admission {
        Ok(descriptor) => {
            steps.push(HealthStepResult {
                step: "PORT_SUPPORTED".to_string(),
                pass: true,
                code: "PORT_SUPPORTED".to_string(),
                message: "Port matches supported USB adapter allowlist.".to_string(),
                details: descriptor
                    .usb
                    .map(|usb| format!("VID={:04X}, PID={:04X}", usb.vid, usb.pid)),
            });
            None
        }
        Err(refusal) => Some(refusal),
    };
    if let Some(refusal) = refusal {
        let (message, details) = match refusal {
            PortRefusal::MacosTtySibling { call_out } => (
                "macOS /dev/tty.* serial paths wait on a carrier signal USB adapters never raise; use the /dev/cu.* path.",
                Some(format!("use {call_out:?}")),
            ),
            PortRefusal::UnsupportedUsb { vid, pid } => (
                "Port is visible but not in supported adapter allowlist.",
                Some(format!("VID={vid:04X}, PID={pid:04X}")),
            ),
            PortRefusal::NotUsb | PortRefusal::NotFound => {
                ("Only supported USB serial adapters are eligible.", None)
            }
        };
        steps.push(HealthStepResult {
            step: "PORT_SUPPORTED".to_string(),
            pass: false,
            code: "PORT_UNSUPPORTED".to_string(),
            message: message.to_string(),
            details,
        });
        return HealthCheckResult::failed(steps);
    }

    // -----------------------------------------------------------------------
    // Step 3: CONNECT_AND_VERIFY — open the port and wait out the bootloader
    // (inside `open_and_settle`), on the blocking pool, never the IPC thread.
    // -----------------------------------------------------------------------
    let mut port_handle = match io.open_and_settle(&port_name) {
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
            return HealthCheckResult::failed(steps);
        }
    };

    // -----------------------------------------------------------------------
    // Step 4: HANDSHAKE — LumaSync v1 PING → PONG round-trip
    //
    // Non-LumaSync firmware fails here. The step is non-fatal (pass=false) so
    // the UI can explain it without blocking the user from using the port with
    // the Adalight profile.
    // -----------------------------------------------------------------------
    let verdict = handshake_verdict(perform_handshake(
        port_handle.as_mut(),
        HANDSHAKE_ROUND_TRIP_TIMEOUT,
    ));
    steps.push(verdict.step);
    let pass = steps.iter().all(|s| s.pass);
    let pong = verdict.pong;
    HealthCheckResult {
        pass,
        steps,
        checked_at_unix_ms: now_unix_ms(),
        round_trip_ms: verdict.round_trip_ms,
        firmware_version: pong.as_ref().map(HandshakePongResponse::version_string),
        advertised_firmware_profile: pong.as_ref().map(|pong| pong.firmware_profile),
        firmware: pong.as_ref().map(SerialFirmwareInfo::from_pong),
    }
}

/// The HANDSHAKE step and the handshake data it lets the result carry.
struct HandshakeVerdict {
    step: HealthStepResult,
    round_trip_ms: Option<u32>,
    pong: Option<HandshakePongResponse>,
}

/// A PONG outside the version window still passes, with
/// `SERIAL_HEALTH_VERSION_MISMATCH` as a warning: streaming continues, so
/// failing the check would claim a fault the strip does not show.
fn handshake_verdict(
    result: Result<(HandshakePongResponse, u32), HandshakeError>,
) -> HandshakeVerdict {
    match result {
        Ok((response, elapsed_ms)) => {
            let (code, message) = match version_window_warning(&response) {
                Some(warning) => ("SERIAL_HEALTH_VERSION_MISMATCH", warning),
                None => (
                    "SERIAL_HEALTH_OK",
                    format!(
                        "Handshake succeeded: firmware {} ({:?}, {:?} pixels), round-trip {}ms.",
                        response.version_string(),
                        response.firmware_profile,
                        response.pixel_layout,
                        elapsed_ms
                    ),
                ),
            };
            HandshakeVerdict {
                step: HealthStepResult {
                    step: "HANDSHAKE".to_string(),
                    pass: true,
                    code: code.to_string(),
                    message,
                    details: Some(format!("round_trip_ms={elapsed_ms}")),
                },
                round_trip_ms: Some(elapsed_ms),
                pong: Some(response),
            }
        }
        Err(err) => {
            let (message, hint) = handshake_error_ui_message(&err);
            HandshakeVerdict {
                step: HealthStepResult {
                    step: "HANDSHAKE".to_string(),
                    pass: false,
                    code: err.as_status_code().to_string(),
                    message,
                    details: Some(hint),
                },
                round_trip_ms: None,
                pong: None,
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

/// Returns `true` for paths that should be suppressed from enumeration on macOS
/// — the `/dev/tty.*` sibling of a `/dev/cu.*` port stalls on DCD instead of
/// failing outright. See docs/architecture/device-output.md. No-op on
/// Linux/Windows.
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
        // The macOS CH340 driver can wedge — after the app was killed mid-stream, or after rapid
        // open/close — and then refuses every open's termios setup with EINVAL until the cable is
        // re-plugged. serialport keeps no errno, only nix's fixed description for it.
        serialport::ErrorKind::Unknown if error.description == "Invalid argument" => {
            "CONNECT_REPLUG_REQUIRED"
        }
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
        HandshakeError::UnknownPixelLayout => (
            "Handshake failed: firmware advertised an unknown pixel layout.".to_string(),
            "Upgrade firmware; this app knows RGB and RGBW pixels under LumaSync v1.".to_string(),
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

/// Status for a connect that did not end with an open port. It never carries
/// the attempted name as `port_name`: an echoed name reads as the connected
/// port to the frontend, and before `apply_mode_change` also required
/// `connected` it was opened by the next mode change — past the allowlist. See
/// docs/architecture/device-output.md. The name goes in `details` instead.
pub(crate) fn failed_connect_status(
    attempted_port: &str,
    code: &str,
    message: &str,
    details: Option<String>,
) -> SerialConnectionStatus {
    let details = match details {
        Some(details) => format!("port={attempted_port:?}; {details}"),
        None => format!("port={attempted_port:?}"),
    };
    SerialConnectionStatus {
        port_name: None,
        connected: false,
        status: command_status(code, message, Some(details)),
        updated_at_unix_ms: now_unix_ms(),
        firmware: None,
    }
}

// ---------------------------------------------------------------------------
// Serial port watcher — notices a strip unplugged and plugged back in
// ---------------------------------------------------------------------------

/// `SerialPortsChangedEvent` in `src/shared/contracts/device.ts`.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SerialPortsChangedEvent {
    pub ports: Vec<SerialPortDescriptor>,
    /// Supported ports that were not there at the last poll.
    pub appeared: Vec<String>,
    /// Supported ports gone for `MISSES_BEFORE_LOST` polls in a row.
    pub lost: Vec<String>,
}

pub const SERIAL_WATCH_INTERVAL: Duration = Duration::from_millis(1_500);
/// One listing that misses a port is not an unplug.
const MISSES_BEFORE_LOST: u8 = 2;

/// What one poll decided: the event to announce, the ports whose cached writers to drop, and the
/// registry after any port it cleared.
#[derive(Default)]
pub struct SerialWatchOutcome {
    pub event: Option<SerialPortsChangedEvent>,
    pub forget: Vec<String>,
    pub registry: Option<local_outputs::LocalOutputsSnapshot>,
}

/// The watcher's memory between polls. Enumeration opens nothing on any platform, so a poll never
/// collides with a connect or its settle.
#[derive(Default)]
pub struct SerialWatch {
    /// Supported ports seen at the last poll; `None` before the first, which is a baseline.
    present: Option<BTreeSet<String>>,
    misses: BTreeMap<String, u8>,
}

impl SerialWatch {
    /// One poll over a listing taken at `listed_at`. Every connected port is checked on every poll,
    /// so a connect that finished after its port vanished is still caught; a connect that finished
    /// after the listing is never cleared by it.
    pub fn poll(
        &mut self,
        ports: Vec<SerialPortDescriptor>,
        listed_at: u128,
        registry: &LocalOutputRegistry,
    ) -> SerialWatchOutcome {
        let now: BTreeSet<String> = ports
            .iter()
            .filter(|port| port.is_supported)
            .map(|port| port.name.clone())
            .collect();
        let connected = registry.connected_serial_ports();

        let Some(present) = self.present.as_mut() else {
            self.present = Some(now);
            return SerialWatchOutcome::default();
        };
        let mut watched: BTreeSet<String> = present.clone();
        watched.extend(connected.clone());
        let mut lost = Vec::new();
        for name in &watched {
            if now.contains(name) {
                self.misses.remove(name);
                continue;
            }
            let count = self
                .misses
                .get(name)
                .copied()
                .unwrap_or(0)
                .saturating_add(1);
            self.misses.insert(name.clone(), count);
            if count == MISSES_BEFORE_LOST {
                lost.push(name.clone());
            }
        }
        for name in &lost {
            present.remove(name);
        }
        let appeared: Vec<String> = now.difference(present).cloned().collect();
        present.extend(appeared.iter().cloned());

        // Every lost port's writer is dropped, connected or not — a port let go of may still hold
        // its cached exclusive handle — unless a connect landed after the listing.
        let mut forget: Vec<String> = lost
            .iter()
            .filter(|port| !registry.connected_since(port, listed_at))
            .cloned()
            .collect();
        let mut cleared = None;
        for port in &lost {
            cleared = registry.serial_lost(port, listed_at).or(cleared);
        }
        // `>=`, not `lost`: a connect that finished after the listing skips the clear once, and the
        // port stays in `watched` while it is a connected one, so the next poll tries again.
        for port in connected.into_iter().filter(|port| {
            !lost.contains(port)
                && self
                    .misses
                    .get(port)
                    .is_some_and(|m| *m >= MISSES_BEFORE_LOST)
        }) {
            if let Some(snapshot) = registry.serial_lost(&port, listed_at) {
                cleared = Some(snapshot);
                forget.push(port);
            }
        }

        if appeared.is_empty() && lost.is_empty() && cleared.is_none() {
            return SerialWatchOutcome::default();
        }
        SerialWatchOutcome {
            event: Some(SerialPortsChangedEvent {
                ports,
                appeared,
                lost,
            }),
            forget,
            registry: cleared,
        }
    }
}

/// Polls the serial inventory for the life of the app. Not tied to window visibility: lighting runs
/// from the tray with every window hidden.
pub fn spawn_serial_watch<R: tauri::Runtime>(app: tauri::AppHandle<R>) {
    let spawned = std::thread::Builder::new()
        .name("lumasync-serial-watch".into())
        .spawn(move || {
            let mut watch = SerialWatch::default();
            loop {
                std::thread::sleep(SERIAL_WATCH_INTERVAL);
                serial_watch_tick(&app, &mut watch);
            }
        });
    if let Err(error) = spawned {
        log::warn!("[serial-watch] could not start: {error}");
    }
}

pub(crate) fn serial_watch_tick<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    watch: &mut SerialWatch,
) {
    use tauri::{Emitter, Manager};
    let listed_at = now_unix_ms();
    let Ok(listing) = list_serial_ports_blocking(&app.state::<SerialPortAccess>()) else {
        return;
    };
    let outcome = watch.poll(
        listing.ports,
        listed_at,
        &app.state::<LocalOutputRegistry>(),
    );
    // The registry first: a reader that sees a port go learns from it whether the strip was lost.
    if let Some(snapshot) = outcome.registry {
        local_outputs::announce(app, snapshot);
    }
    if let Some(event) = outcome.event {
        log::info!(
            "[serial-watch] appeared={:?} lost={:?}",
            event.appeared,
            event.lost
        );
        if let Err(error) = app.emit_to(
            crate::MAIN_WINDOW_LABEL,
            crate::events::DEVICE_SERIAL_PORTS_CHANGED_EVENT,
            event,
        ) {
            log::warn!("[serial-watch] could not announce the change: {error}");
        }
    }
    if let Some(lighting) = app.try_state::<super::lighting_mode::LightingRuntimeState>() {
        // The running mode wrote to a strip that went while another output remains: it moves onto
        // that one. With nothing left, the main window's unplug handling trims or ends the mode.
        let moves = outcome
            .forget
            .iter()
            .any(|port| lighting.drives_serial(port))
            && app.state::<LocalOutputRegistry>().driven().is_some();
        for port in &outcome.forget {
            lighting.forget_serial_session(port);
        }
        if moves {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(error) = super::lighting_mode::outputs::refresh_running_with(&app).await
                {
                    log::warn!("[serial-watch] the mode did not move onto what remains: {error}");
                }
            });
        }
    }
}

pub(crate) fn now_unix_ms() -> u128 {
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
    use std::time::Duration;

    use serialport::{SerialPortInfo, SerialPortType, UsbPortInfo};

    use super::super::device_handshake::{SerialRoundTrip, FRAME_MAGIC, HANDSHAKE_OPCODE_PONG};
    use super::super::led_output::{FirmwareProfile, WirePixelLayout};
    use super::{
        is_macos_tty_path, is_supported_usb, run_serial_health_check_blocking, HealthCheckResult,
        HealthStepResult, SerialFirmwareInfo, SerialPortIo, SettledPort,
        SUPPORTED_USB_DEVICE_ALLOWLIST,
    };

    // ---------------------------------------------------------------------------
    // Serial port watcher
    // ---------------------------------------------------------------------------

    fn supported(name: &str) -> super::SerialPortDescriptor {
        super::SerialPortDescriptor {
            name: name.to_string(),
            kind: "usb".to_string(),
            is_supported: true,
            support_reason: "PORT_SUPPORTED".to_string(),
            usb: None,
        }
    }

    fn connected_at(state: &super::LocalOutputRegistry, port: &str, at: u128) {
        state.set_serial_for_tests(port, true, at);
    }

    fn is_connected(state: &super::LocalOutputRegistry) -> bool {
        state.connected_serial_port().is_some()
    }

    #[test]
    fn the_first_poll_is_a_baseline_and_announces_nothing() {
        let mut watch = super::SerialWatch::default();
        let state = super::LocalOutputRegistry::default();
        let outcome = watch.poll(vec![supported("COM3")], 10, &state);
        assert!(outcome.event.is_none());
        assert!(outcome.forget.is_empty());
    }

    // One listing that misses a port is not an unplug.
    #[test]
    fn a_connected_port_is_lost_after_two_missed_polls_and_its_status_cleared() {
        let mut watch = super::SerialWatch::default();
        let state = super::LocalOutputRegistry::default();
        connected_at(&state, "COM3", 5);
        watch.poll(vec![supported("COM3")], 10, &state);

        let first = watch.poll(Vec::new(), 20, &state);
        assert!(first.event.is_none());
        assert!(is_connected(&state));

        let second = watch.poll(Vec::new(), 30, &state);
        let event = second.event.expect("the loss is announced");
        assert_eq!(event.lost, vec!["COM3".to_string()]);
        assert_eq!(second.forget, vec!["COM3".to_string()]);
        assert!(!is_connected(&state));
        let snapshot = second.registry.expect("the registry is announced");
        let entry =
            serde_json::to_value(&snapshot).expect("snapshot serialises")["outputs"][0].clone();
        assert_eq!(entry["connected"], false);
        assert_eq!(entry["status"]["code"], "PORT_NOT_FOUND");

        let back = watch.poll(vec![supported("COM3")], 40, &state);
        assert_eq!(
            back.event.expect("the return is announced").appeared,
            vec!["COM3".to_string()]
        );
    }

    // A replug connect that landed after the listing was taken is not wiped by it.
    #[test]
    fn a_connect_newer_than_the_listing_is_left_alone() {
        let mut watch = super::SerialWatch::default();
        let state = super::LocalOutputRegistry::default();
        watch.poll(vec![supported("COM3")], 10, &state);
        watch.poll(Vec::new(), 20, &state);
        connected_at(&state, "COM3", 35);

        let outcome = watch.poll(Vec::new(), 30, &state);

        assert!(outcome.forget.is_empty());
        assert!(is_connected(&state));
    }

    // The loss is announced once, but a connected port still missing is cleared on a later poll.
    #[test]
    fn a_connected_port_that_skipped_its_clear_is_cleared_on_the_next_poll() {
        let mut watch = super::SerialWatch::default();
        let state = super::LocalOutputRegistry::default();
        watch.poll(vec![supported("COM3")], 10, &state);
        watch.poll(Vec::new(), 20, &state);
        connected_at(&state, "COM3", 35);
        let skipped = watch.poll(Vec::new(), 30, &state);
        assert!(skipped.forget.is_empty());

        let next = watch.poll(Vec::new(), 40, &state);

        assert_eq!(next.forget, vec!["COM3".to_string()]);
        let event = next.event.expect("the clear is announced");
        assert!(event.lost.is_empty());
        assert!(next.registry.is_some());
        assert!(!is_connected(&state));
    }

    // A port let go of is no longer connected, yet its cached writer may still hold it.
    #[test]
    fn a_lost_port_that_was_not_connected_still_has_its_writer_dropped() {
        let mut watch = super::SerialWatch::default();
        let state = super::LocalOutputRegistry::default();
        watch.poll(vec![supported("COM3")], 10, &state);
        watch.poll(Vec::new(), 20, &state);

        let outcome = watch.poll(Vec::new(), 30, &state);

        assert_eq!(outcome.forget, vec!["COM3".to_string()]);
        assert!(outcome.registry.is_none());
    }

    #[test]
    fn a_port_the_system_refuses_asks_for_a_replug() {
        let wedged = serialport::Error::new(serialport::ErrorKind::Unknown, "Invalid argument");
        assert_eq!(
            super::connect_error_code(&wedged),
            "CONNECT_REPLUG_REQUIRED"
        );
        let other = serialport::Error::new(serialport::ErrorKind::Unknown, "Something else");
        assert_eq!(super::connect_error_code(&other), "CONNECT_FAILED");
    }

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
    // The four entries added after the first five
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

    // The two filter-positive assertions only hold on macOS — on Linux/Windows
    // `is_macos_tty_path` is a compile-time `false`, so these tests would fire
    // bogus failures from the cross-platform CI legs. Gate them per target.

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_tty_usbserial_is_filtered() {
        // The exact path from the real incident on 2026-04-26.
        assert!(
            is_macos_tty_path("/dev/tty.usbserial-10"),
            "/dev/tty.usbserial-10 must be filtered on macOS"
        );
    }

    #[cfg(target_os = "macos")]
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
    // Health check over the `SerialPortIo` seam — the real blocking core,
    // with the device's reply scripted.
    // ---------------------------------------------------------------------------

    /// A settled handle that answers every read with the scripted bytes once.
    struct ScriptedPort {
        reply: Vec<u8>,
    }

    impl SerialRoundTrip for ScriptedPort {
        fn write_all(&mut self, _bytes: &[u8]) -> std::io::Result<()> {
            Ok(())
        }

        fn read_with_timeout(
            &mut self,
            buf: &mut [u8],
            _timeout: Duration,
        ) -> std::io::Result<usize> {
            let n = buf.len().min(self.reply.len());
            buf[..n].copy_from_slice(&self.reply[..n]);
            self.reply.drain(..n);
            Ok(n)
        }
    }

    struct OnePort {
        reply: Vec<u8>,
    }

    const PORT: &str = "/dev/cu.usbserial-health";

    impl SerialPortIo for OnePort {
        fn available_ports(&self) -> serialport::Result<Vec<SerialPortInfo>> {
            Ok(vec![SerialPortInfo {
                port_name: PORT.to_string(),
                port_type: SerialPortType::UsbPort(UsbPortInfo {
                    vid: 0x1A86,
                    pid: 0x7523,
                    serial_number: None,
                    manufacturer: None,
                    product: None,
                }),
            }])
        }

        fn open_and_settle(&self, _port_name: &str) -> serialport::Result<SettledPort> {
            Ok(Box::new(ScriptedPort {
                reply: self.reply.clone(),
            }))
        }
    }

    /// Build a correctly checksummed 7-byte PONG frame.
    fn build_pong(fw_version: u16, format_byte: u8) -> Vec<u8> {
        let ver = fw_version.to_le_bytes();
        let mut frame = vec![
            FRAME_MAGIC[0],
            FRAME_MAGIC[1],
            HANDSHAKE_OPCODE_PONG,
            ver[0],
            ver[1],
            format_byte,
        ];
        let checksum = frame.iter().fold(0_u8, |acc, b| acc ^ b);
        frame.push(checksum);
        frame
    }

    fn health_check_with_reply(reply: Vec<u8>) -> HealthCheckResult {
        run_serial_health_check_blocking(&OnePort { reply }, PORT.to_string())
    }

    fn handshake_step(result: &HealthCheckResult) -> &HealthStepResult {
        result
            .steps
            .iter()
            .find(|step| step.step == "HANDSHAKE")
            .expect("the check reached the HANDSHAKE step")
    }

    #[test]
    fn health_check_carries_the_advertised_profile_and_layout() {
        let result = health_check_with_reply(build_pong(0x0105, 0x11));

        assert!(result.pass, "every step passes");
        assert_eq!(handshake_step(&result).code, "SERIAL_HEALTH_OK");
        assert_eq!(result.firmware_version.as_deref(), Some("1.5"));
        assert_eq!(
            result.advertised_firmware_profile,
            Some(FirmwareProfile::LumaSyncV1)
        );
        assert_eq!(
            result.firmware,
            Some(SerialFirmwareInfo {
                version: "1.5".to_string(),
                version_raw: 0x0105,
                profile: FirmwareProfile::LumaSyncV1,
                pixel_layout: WirePixelLayout::Rgbw,
            })
        );
    }

    #[test]
    fn health_check_reports_an_adalight_advertisement() {
        let result = health_check_with_reply(build_pong(0x0105, 0x02));
        assert_eq!(
            result.advertised_firmware_profile,
            Some(FirmwareProfile::Adalight)
        );
        assert!(result.pass);
    }

    #[test]
    fn a_version_outside_the_window_passes_with_a_mismatch_warning() {
        for version in [0x0200_u16, 0x0009] {
            let result = health_check_with_reply(build_pong(version, 0x01));
            let step = handshake_step(&result);

            assert!(step.pass, "a warning, not a failure ({version:#06x})");
            assert!(result.pass, "streaming continues, so the check passes");
            assert_eq!(step.code, "SERIAL_HEALTH_VERSION_MISMATCH");
            assert!(
                result.firmware.is_some(),
                "the PONG is still reported ({version:#06x})"
            );
        }
    }

    #[test]
    fn a_silent_device_fails_the_handshake_with_no_firmware_data() {
        let result = health_check_with_reply(Vec::new());
        let step = handshake_step(&result);

        assert!(!step.pass);
        assert!(!result.pass);
        assert_eq!(step.code, "SERIAL_HEALTH_HANDSHAKE_TIMEOUT");
        assert_eq!(result.advertised_firmware_profile, None);
        assert_eq!(result.round_trip_ms, None);
        assert_eq!(result.firmware, None);
    }

    #[test]
    fn a_garbled_reply_is_a_protocol_error_with_no_firmware_data() {
        let result = health_check_with_reply(vec![0xDE, 0xAD, 0xBE, 0xEF, 0x11, 0x22, 0x33]);
        let step = handshake_step(&result);

        assert!(!step.pass);
        assert_eq!(step.code, "SERIAL_HEALTH_PROTOCOL_ERROR");
        assert_eq!(result.advertised_firmware_profile, None);
        assert_eq!(result.firmware, None);
    }

    #[test]
    fn an_unknown_layout_nibble_is_a_protocol_error() {
        let result = health_check_with_reply(build_pong(0x0105, 0x21));
        assert_eq!(handshake_step(&result).code, "SERIAL_HEALTH_PROTOCOL_ERROR");
        assert_eq!(result.firmware, None);
    }

    #[test]
    fn firmware_is_left_off_the_wire_when_absent() {
        let result = health_check_with_reply(Vec::new());
        let json = serde_json::to_value(&result).expect("serialises");
        assert!(json.get("firmware").is_none(), "got: {json}");

        let answered = health_check_with_reply(build_pong(0x0104, 0x11));
        let json = serde_json::to_value(&answered).expect("serialises");
        assert_eq!(json["firmware"]["pixelLayout"], "rgbw");
        assert_eq!(json["firmware"]["versionRaw"], 0x0104);
        assert_eq!(json["firmware"]["profile"], "lumasync-v1");
    }
}
