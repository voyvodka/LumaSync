//! The local outputs — USB serial strips and the bound WLED device — as one registry of hardware
//! facts. It replaces a status that every connect attempt overwrote and a sink slot that a failed
//! serial attempt emptied. Serial and WLED still evict each other (one local output at a time) until
//! the worker drives several; see docs/architecture/device-output.md.

use std::collections::BTreeMap;
use std::sync::{Mutex, MutexGuard};

use serde::Serialize;

use super::device_connection::{
    command_status, failed_connect_status, now_unix_ms, SerialConnectionStatus, SerialFirmwareInfo,
};
use super::status::CommandStatus;
use super::wled_sink::WledSinkConfig;

/// `SerialOutputStatus` in `src/shared/contracts/device.ts`.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SerialOutputStatus {
    pub port_name: String,
    pub connected: bool,
    pub status: CommandStatus,
    pub firmware: Option<SerialFirmwareInfo>,
    pub updated_at_unix_ms: u128,
}

/// `WledOutputStatus` in `src/shared/contracts/device.ts`.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WledOutputStatus {
    pub ip: String,
    pub led_count: u16,
    pub connected: bool,
}

/// `LocalOutputStatus` in `src/shared/contracts/device.ts`.
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum LocalOutputStatus {
    Serial(SerialOutputStatus),
    Wled(WledOutputStatus),
}

/// `DrivenOutputRef` in `src/shared/contracts/device.ts`: which output the "usb" channel drives,
/// named so the frontend reads the rule instead of repeating it.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum DrivenOutputRef {
    Serial { port_name: String },
    Wled { ip: String },
}

/// `LocalOutputsSnapshot` in `src/shared/contracts/device.ts`.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalOutputsSnapshot {
    pub revision: u64,
    pub outputs: Vec<LocalOutputStatus>,
    pub driven: Option<DrivenOutputRef>,
}

/// What the "usb" channel drives. A bound WLED device wins over a connected serial port — with
/// eviction both at once only happens for the instant between two writes, and the order is the one
/// every planner used.
#[derive(Clone, Debug, PartialEq)]
pub enum DrivenLocal {
    Serial(String),
    Wled(WledSinkConfig),
}

impl DrivenLocal {
    /// `apply_mode_change`'s three channel arguments.
    pub fn plan_args(driven: Option<&Self>) -> (bool, Option<&str>, Option<WledSinkConfig>) {
        match driven {
            Some(Self::Serial(port)) => (true, Some(port.as_str()), None),
            Some(Self::Wled(config)) => (false, None, Some(*config)),
            None => (false, None, None),
        }
    }
}

/// What `serial_disconnected` replaced.
pub struct DisconnectedSerial {
    entry: SerialOutputStatus,
    last_serial: SerialConnectionStatus,
}

struct Inner {
    revision: u64,
    serial: BTreeMap<String, SerialOutputStatus>,
    wled: Option<WledSinkConfig>,
    /// What `get_serial_connection_status` returns, written exactly as before the registry: the
    /// frontend reads it until it moves to `get_local_outputs`, and it has no copy for the states
    /// the per-port entries can now say.
    last_serial: SerialConnectionStatus,
}

pub struct LocalOutputRegistry {
    inner: Mutex<Inner>,
}

impl Default for LocalOutputRegistry {
    fn default() -> Self {
        Self {
            inner: Mutex::new(Inner {
                revision: 0,
                serial: BTreeMap::new(),
                wled: None,
                last_serial: SerialConnectionStatus {
                    port_name: None,
                    connected: false,
                    status: command_status(
                        "NOT_CONNECTED",
                        "No serial connection attempt yet.",
                        None,
                    ),
                    updated_at_unix_ms: now_unix_ms(),
                    firmware: None,
                },
            }),
        }
    }
}

fn disconnected_status(message: &str, details: Option<String>) -> CommandStatus {
    command_status("DISCONNECTED", message, details)
}

impl Inner {
    fn snapshot(&self) -> LocalOutputsSnapshot {
        let mut outputs: Vec<LocalOutputStatus> = self
            .serial
            .values()
            .cloned()
            .map(LocalOutputStatus::Serial)
            .collect();
        if let Some(config) = self.wled {
            outputs.push(LocalOutputStatus::Wled(WledOutputStatus {
                ip: config.ip.to_string(),
                led_count: config.led_count,
                connected: true,
            }));
        }
        LocalOutputsSnapshot {
            revision: self.revision,
            outputs,
            driven: driven_in(self).map(|driven| match driven {
                DrivenLocal::Serial(port_name) => DrivenOutputRef::Serial { port_name },
                DrivenLocal::Wled(config) => DrivenOutputRef::Wled {
                    ip: config.ip.to_string(),
                },
            }),
        }
    }

    fn changed(&mut self) -> LocalOutputsSnapshot {
        self.revision += 1;
        self.snapshot()
    }

    /// Every connected serial port but `except` stops being connected: one local output at a time.
    fn evict_serial(&mut self, except: Option<&str>, by: &str) {
        let now = now_unix_ms();
        for entry in self.serial.values_mut() {
            if entry.connected && Some(entry.port_name.as_str()) != except {
                entry.connected = false;
                entry.status = disconnected_status(
                    "Another output took the strip's place.",
                    Some(format!("replaced by {by}")),
                );
                entry.updated_at_unix_ms = now;
            }
        }
    }
}

fn driven_in(inner: &Inner) -> Option<DrivenLocal> {
    if let Some(config) = inner.wled {
        return Some(DrivenLocal::Wled(config));
    }
    inner
        .serial
        .values()
        .find(|entry| entry.connected)
        .map(|entry| DrivenLocal::Serial(entry.port_name.clone()))
}

impl LocalOutputRegistry {
    // A poisoned lock still holds the last consistent facts; every writer replaces whole values.
    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// A connect that succeeded. Evicts the other local outputs.
    pub fn serial_connected(&self, status: SerialConnectionStatus) -> LocalOutputsSnapshot {
        let mut inner = self.lock();
        if let Some(port) = status.output_port().map(str::to_owned) {
            inner.evict_serial(Some(&port), &format!("port={port:?}"));
            inner.wled = None;
            inner.serial.insert(
                port.clone(),
                SerialOutputStatus {
                    port_name: port,
                    connected: true,
                    status: status.status.clone(),
                    firmware: status.firmware.clone(),
                    updated_at_unix_ms: status.updated_at_unix_ms,
                },
            );
        }
        inner.last_serial = status;
        inner.changed()
    }

    /// A connect that failed. `admitted_port` is the port when it passed admission — a refused name
    /// never becomes an entry. Another connected port and a bound WLED device are left alone, and so
    /// is this port when it is connected: a second attempt on a live port (two boot reconnects racing)
    /// fails on the open, and must not mark the strip that is lighting as off.
    pub fn serial_failed(
        &self,
        admitted_port: Option<&str>,
        status: SerialConnectionStatus,
    ) -> LocalOutputsSnapshot {
        let mut inner = self.lock();
        let live = admitted_port
            .is_some_and(|port| inner.serial.get(port).is_some_and(|entry| entry.connected));
        if let Some(port) = admitted_port.filter(|_| !live) {
            inner.serial.insert(
                port.to_string(),
                SerialOutputStatus {
                    port_name: port.to_string(),
                    connected: false,
                    status: status.status.clone(),
                    firmware: None,
                    updated_at_unix_ms: status.updated_at_unix_ms,
                },
            );
        }
        // The compatibility status too: it would read the live strip as failed.
        if !live {
            inner.last_serial = status;
        }
        inner.changed()
    }

    /// A WLED device bound to the "usb" channel. Evicts a connected serial port; the compatibility
    /// status keeps saying what it said, as it always has.
    pub fn wled_bound(&self, config: WledSinkConfig) -> LocalOutputsSnapshot {
        let mut inner = self.lock();
        inner.evict_serial(None, &format!("wled {}", config.ip));
        inner.wled = Some(config);
        inner.changed()
    }

    /// Unbinds the WLED device at `ip`; `None` when a different one (or none) is bound.
    pub fn wled_forgotten(&self, ip: std::net::Ipv4Addr) -> Option<LocalOutputsSnapshot> {
        let mut inner = self.lock();
        if inner.wled.is_some_and(|config| config.ip == ip) {
            inner.wled = None;
            Some(inner.changed())
        } else {
            None
        }
    }

    /// The watcher found `port` gone. Cleared only when nothing connected it after `listed_at`:
    /// a replug that landed after the listing is not undone by it.
    pub fn serial_lost(&self, port: &str, listed_at: u128) -> Option<LocalOutputsSnapshot> {
        let mut inner = self.lock();
        let mut changed = false;
        if let Some(entry) = inner.serial.get_mut(port) {
            if entry.connected && entry.updated_at_unix_ms < listed_at {
                let lost = failed_connect_status(
                    port,
                    "PORT_NOT_FOUND",
                    "The serial port went away.",
                    Some("unplugged".to_string()),
                );
                entry.connected = false;
                entry.status = lost.status;
                entry.updated_at_unix_ms = lost.updated_at_unix_ms;
                changed = true;
            }
        }
        let compat = &inner.last_serial;
        if compat.output_port() == Some(port) && compat.updated_at_unix_ms < listed_at {
            inner.last_serial = failed_connect_status(
                port,
                "PORT_NOT_FOUND",
                "The serial port went away.",
                Some("unplugged".to_string()),
            );
            changed = true;
        }
        changed.then(|| inner.changed())
    }

    /// The user let go of `port`. `None` when it is not the connected one; otherwise the snapshot
    /// and what it replaced, for `restore_serial` when the lighting could not let go.
    pub fn serial_disconnected(
        &self,
        port: &str,
    ) -> Option<(LocalOutputsSnapshot, DisconnectedSerial)> {
        let mut inner = self.lock();
        let before_last = inner.last_serial.clone();
        let entry = inner.serial.get_mut(port).filter(|entry| entry.connected)?;
        let before_entry = entry.clone();
        entry.connected = false;
        entry.status = disconnected_status("Disconnected.", None);
        entry.updated_at_unix_ms = now_unix_ms();
        if inner.last_serial.output_port() == Some(port) {
            inner.last_serial = SerialConnectionStatus {
                port_name: None,
                connected: false,
                status: disconnected_status("Disconnected.", Some(format!("port={port:?}"))),
                updated_at_unix_ms: now_unix_ms(),
                firmware: None,
            };
        }
        Some((
            inner.changed(),
            DisconnectedSerial {
                entry: before_entry,
                last_serial: before_last,
            },
        ))
    }

    /// Puts back a disconnect the lighting refused, unless another output was connected since.
    pub fn restore_serial(&self, previous: DisconnectedSerial) -> Option<LocalOutputsSnapshot> {
        let mut inner = self.lock();
        let taken = inner.wled.is_some() || inner.serial.values().any(|entry| entry.connected);
        if taken {
            return None;
        }
        inner
            .serial
            .insert(previous.entry.port_name.clone(), previous.entry);
        inner.last_serial = previous.last_serial;
        Some(inner.changed())
    }

    /// Shutdown: nothing is driven any more.
    pub fn clear(&self) {
        let mut inner = self.lock();
        inner.wled = None;
        inner.evict_serial(None, "shutdown");
        inner.changed();
    }

    pub fn driven(&self) -> Option<DrivenLocal> {
        driven_in(&self.lock())
    }

    /// `driven` for a mode apply, which refuses on a poisoned lock rather than plan an output from
    /// facts a panicking writer may have left half-written.
    pub fn driven_checked(&self) -> Result<Option<DrivenLocal>, String> {
        self.inner
            .lock()
            .map(|inner| driven_in(&inner))
            .map_err(|error| format!("LIGHTING_CONNECTION_STATE_LOCK_FAILED: {error}"))
    }

    #[cfg(test)]
    pub fn poison_for_tests(&self) {
        let _ = std::thread::scope(|scope| {
            scope
                .spawn(|| {
                    let _guard = self.inner.lock();
                    panic!("poisoning the registry on purpose");
                })
                .join()
        });
    }

    /// `port` was connected at or after `listed_at` — a listing that missed it predates the connect.
    pub fn connected_since(&self, port: &str, listed_at: u128) -> bool {
        self.lock()
            .serial
            .get(port)
            .is_some_and(|entry| entry.connected && entry.updated_at_unix_ms >= listed_at)
    }

    pub fn connected_serial_port(&self) -> Option<String> {
        self.lock()
            .serial
            .values()
            .find(|entry| entry.connected)
            .map(|entry| entry.port_name.clone())
    }

    pub fn wled_config(&self) -> Option<WledSinkConfig> {
        self.lock().wled
    }

    /// The compatibility status, as the watcher's event carries it.
    pub fn serial_status(&self) -> SerialConnectionStatus {
        self.lock().last_serial.clone()
    }

    /// `get_serial_connection_status`'s answer, which has always refused on a poisoned lock.
    pub fn serial_status_checked(&self) -> Result<SerialConnectionStatus, String> {
        self.inner
            .lock()
            .map(|inner| inner.last_serial.clone())
            .map_err(|error| {
                format!("STATUS_READ_FAILED: Could not read serial connection status ({error})")
            })
    }

    pub fn snapshot(&self) -> LocalOutputsSnapshot {
        self.lock().snapshot()
    }

    /// Test rigs: `port` connected (or merely named, `connected: false`) without a real connect.
    #[cfg(test)]
    pub fn set_serial_for_tests(&self, port: &str, connected: bool, updated_at_unix_ms: u128) {
        let status = SerialConnectionStatus {
            port_name: Some(port.to_string()),
            connected,
            status: command_status("CONNECT_OK", "test", None),
            updated_at_unix_ms,
            firmware: None,
        };
        if connected {
            self.serial_connected(status);
        } else {
            let mut inner = self.lock();
            inner.last_serial = status;
            inner.changed();
        }
    }
}

/// Announces the registry to the main window after a change.
pub fn announce<R: tauri::Runtime>(app: &tauri::AppHandle<R>, snapshot: LocalOutputsSnapshot) {
    use tauri::Emitter;
    if let Err(error) = app.emit_to(
        crate::MAIN_WINDOW_LABEL,
        crate::events::DEVICE_LOCAL_OUTPUTS_CHANGED_EVENT,
        snapshot,
    ) {
        log::warn!("[local-outputs] could not announce the change: {error}");
    }
}

/// Every local output this session knows of. Never fails: a poisoned lock still holds the last
/// consistent facts.
#[tauri::command]
pub fn get_local_outputs(registry: tauri::State<'_, LocalOutputRegistry>) -> LocalOutputsSnapshot {
    registry.snapshot()
}

/// `SerialDisconnectResult` in `src/shared/contracts/device.ts`.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SerialDisconnectResult {
    pub port_name: String,
    pub status: CommandStatus,
}

fn disconnect_result(
    port: &str,
    code: &str,
    message: &str,
    details: Option<String>,
) -> SerialDisconnectResult {
    SerialDisconnectResult {
        port_name: port.to_string(),
        status: CommandStatus::new(code, message, details),
    }
}

/// Let go of a connected strip: a running mode stops sending to it the way it does after an unplug
/// (session only; a mode it ran alone ends as Off does), then its cached writer closes the port.
#[tauri::command]
pub async fn disconnect_serial_port<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    port_name: String,
) -> SerialDisconnectResult {
    disconnect_serial_with(&app, &port_name).await
}

pub(crate) async fn disconnect_serial_with<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    port: &str,
) -> SerialDisconnectResult {
    use tauri::Manager;

    use super::lighting_mode::outputs::{apply_outputs_with, ApplyOutputsRequest, LightingOrigin};
    use super::lighting_mode::snapshot::OutputTarget;
    use super::lighting_mode::LightingRuntimeState;

    let registry = app.state::<LocalOutputRegistry>();
    // Marked first, so no mode applied while the lighting lets go plans this port again.
    let Some((snapshot, previous)) = registry.serial_disconnected(port) else {
        return disconnect_result(
            port,
            "SERIAL_DISCONNECT_NOT_CONNECTED",
            "That strip is not connected.",
            None,
        );
    };
    announce(app, snapshot);

    let lighting = app.state::<LightingRuntimeState>();
    let before = lighting.snapshot.read();
    let selected = before.selected_targets;
    let lit = before.active_targets.contains(&OutputTarget::Usb);
    if selected.contains(&OutputTarget::Usb) {
        let rest = selected
            .into_iter()
            .filter(|target| *target != OutputTarget::Usb)
            .map(|target| target.as_str().to_string())
            .collect();
        let request = ApplyOutputsRequest {
            mode: None,
            targets: Some(rest),
            origin: LightingOrigin::UsbUnplug,
        };
        // A refusal answers `Ok` too: what counts is whether the strip is still driven.
        let refusal = match apply_outputs_with(app, request).await {
            Err(error) => Some(error),
            Ok(result) if result.snapshot.active_targets.contains(&OutputTarget::Usb) => Some(
                format!("{}: the mode still drives the strip", result.status.code),
            ),
            Ok(_) => None,
        };
        if let Some(error) = refusal {
            log::warn!("[serial-disconnect] the lighting did not let go of {port}: {error}");
            if let Some(snapshot) = registry.restore_serial(previous) {
                announce(app, snapshot);
            }
            return disconnect_result(
                port,
                "SERIAL_DISCONNECT_FAILED",
                "The strip was not disconnected.",
                Some(error),
            );
        }
    }
    // Stopping only stops writing; the strip would hold its last frame. Nothing drives it now, so
    // no worker frame can follow the black one.
    if lit && registry.connected_serial_port().is_none() {
        if let Err(reason) =
            super::lighting_mode::transition::blank_serial_port(app, port, &before.mode)
        {
            log::warn!("[serial-disconnect] {port} kept its last frame: {reason}");
        }
    }
    // A connect of the same port meanwhile owns the cached writer now.
    if registry.connected_serial_port().as_deref() != Some(port) {
        lighting.forget_serial_session(port);
    }
    log::info!("[serial-disconnect] {port} disconnected");
    disconnect_result(
        port,
        "SERIAL_DISCONNECT_OK",
        "The strip was disconnected.",
        None,
    )
}

#[cfg(test)]
#[path = "local_outputs_tests.rs"]
mod tests;
