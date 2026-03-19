use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serialport::{available_ports, SerialPortType};

const DEFAULT_CONNECT_BAUD_RATE: u32 = 115_200;
const DEFAULT_CONNECT_TIMEOUT_MS: u64 = 1_500;

const SUPPORTED_USB_DEVICE_ALLOWLIST: &[(u16, u16)] = &[
    (0x1A86, 0x7523),
    (0x0403, 0x6001),
    (0x10C4, 0xEA60),
    (0x2341, 0x0043),
    (0x2341, 0x0001),
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
) -> SerialConnectionStatus {
    let known_ports = match available_ports() {
        Ok(ports) => ports,
        Err(error) => {
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
        Ok(_port_handle) => SerialConnectionStatus {
            port_name: Some(port_name),
            connected: true,
            status: command_status(
                "CONNECT_OK",
                "Serial port connection attempt succeeded.",
                None,
            ),
            updated_at_unix_ms: now_unix_ms(),
        },
        Err(error) => SerialConnectionStatus {
            port_name: Some(port_name),
            connected: false,
            status: command_status(
                connect_error_code(&error),
                "Serial port connection attempt failed.",
                Some(error.to_string()),
            ),
            updated_at_unix_ms: now_unix_ms(),
        },
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

#[tauri::command]
pub fn run_serial_health_check(port_name: String) -> HealthCheckResult {
    let mut steps = Vec::new();

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
            };
        }
    };

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
            };
        }
    }

    let open_result = serialport::new(&port_name, DEFAULT_CONNECT_BAUD_RATE)
        .timeout(Duration::from_millis(DEFAULT_CONNECT_TIMEOUT_MS))
        .open();

    match open_result {
        Ok(_port_handle) => {
            steps.push(HealthStepResult {
                step: "CONNECT_AND_VERIFY".to_string(),
                pass: true,
                code: "CONNECT_OK".to_string(),
                message: "Connect and immediate verification succeeded.".to_string(),
                details: None,
            });
        }
        Err(error) => {
            steps.push(HealthStepResult {
                step: "CONNECT_AND_VERIFY".to_string(),
                pass: false,
                code: connect_error_code(&error).to_string(),
                message: "Connect and immediate verification failed.".to_string(),
                details: Some(error.to_string()),
            });
        }
    }

    let pass = steps.iter().all(|step| step.pass);
    HealthCheckResult {
        pass,
        steps,
        checked_at_unix_ms: now_unix_ms(),
    }
}

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

fn command_status(code: &str, message: &str, details: Option<String>) -> CommandStatus {
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
