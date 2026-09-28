//! The local outputs — USB serial strips and the bound WLED device — as one registry of hardware
//! facts. It replaces a status that every connect attempt overwrote and a sink slot that a failed
//! serial attempt emptied. Several can be connected at once; until the worker drives several, the
//! earliest connected of them is the one the "usb" channel drives. See
//! docs/architecture/device-output.md.

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

/// What the "usb" channel drives: the earliest connected of the local outputs. A connect never moves
/// it — a strip lighting a running mode keeps lighting it when another is connected — only a leave
/// does.
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
    connected_at: u64,
}

struct Inner {
    revision: u64,
    serial: BTreeMap<String, SerialOutputStatus>,
    wled: Option<WledSinkConfig>,
    /// Connect order: stamped when an output becomes connected, so `driven_in` picks the earliest.
    next_connect: u64,
    serial_connected_at: BTreeMap<String, u64>,
    wled_connected_at: u64,
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
                next_connect: 0,
                serial_connected_at: BTreeMap::new(),
                wled_connected_at: 0,
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

    fn stamp(&mut self) -> u64 {
        self.next_connect += 1;
        self.next_connect
    }

    /// Every connected serial port stops being connected: the app is shutting down.
    fn release_all_serial(&mut self, by: &str) {
        let now = now_unix_ms();
        for entry in self.serial.values_mut() {
            if entry.connected {
                entry.connected = false;
                entry.status = disconnected_status("Disconnected.", Some(by.to_string()));
                entry.updated_at_unix_ms = now;
            }
        }
    }
}

fn driven_in(inner: &Inner) -> Option<DrivenLocal> {
    let serial = inner
        .serial
        .values()
        .filter(|entry| entry.connected)
        .map(|entry| {
            let at = inner
                .serial_connected_at
                .get(&entry.port_name)
                .copied()
                .unwrap_or(u64::MAX);
            (at, DrivenLocal::Serial(entry.port_name.clone()))
        });
    let wled = inner
        .wled
        .map(|config| (inner.wled_connected_at, DrivenLocal::Wled(config)));
    serial
        .chain(wled)
        .min_by_key(|(at, _)| *at)
        .map(|(_, driven)| driven)
}

impl LocalOutputRegistry {
    // A poisoned lock still holds the last consistent facts; every writer replaces whole values.
    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// A connect that succeeded. The other local outputs stay connected; a port connected again keeps
    /// its place in the connect order.
    pub fn serial_connected(&self, status: SerialConnectionStatus) -> LocalOutputsSnapshot {
        let mut inner = self.lock();
        if let Some(port) = status.output_port().map(str::to_owned) {
            let already = inner.serial.get(&port).is_some_and(|entry| entry.connected);
            if !already {
                let at = inner.stamp();
                inner.serial_connected_at.insert(port.clone(), at);
            }
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
        inner.changed()
    }

    /// A WLED device bound to the "usb" channel. Connected strips stay connected; the same device bound
    /// again keeps its place in the connect order, a different one takes a new place.
    pub fn wled_bound(&self, config: WledSinkConfig) -> LocalOutputsSnapshot {
        let mut inner = self.lock();
        if inner.wled.is_none_or(|bound| bound.ip != config.ip) {
            inner.wled_connected_at = inner.stamp();
        }
        inner.wled = Some(config);
        inner.changed()
    }

    /// Binds `config` again in the place it had, for a forget the lighting refused. `None` when
    /// another device was bound meanwhile.
    pub fn restore_wled(
        &self,
        config: WledSinkConfig,
        connected_at: u64,
    ) -> Option<LocalOutputsSnapshot> {
        let mut inner = self.lock();
        if inner.wled.is_some() {
            return None;
        }
        inner.wled = Some(config);
        inner.wled_connected_at = connected_at;
        Some(inner.changed())
    }

    /// Where the bound WLED device stands in the connect order, for `restore_wled`.
    pub fn wled_connected_at(&self) -> u64 {
        self.lock().wled_connected_at
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
        changed.then(|| inner.changed())
    }

    /// The user let go of `port`. `None` when it is not the connected one; otherwise the snapshot
    /// and what it replaced, for `restore_serial` when the lighting could not let go.
    pub fn serial_disconnected(
        &self,
        port: &str,
    ) -> Option<(LocalOutputsSnapshot, DisconnectedSerial)> {
        let mut inner = self.lock();
        let connected_at = inner.serial_connected_at.get(port).copied().unwrap_or(0);
        let entry = inner.serial.get_mut(port).filter(|entry| entry.connected)?;
        let before_entry = entry.clone();
        entry.connected = false;
        entry.status = disconnected_status("Disconnected.", None);
        entry.updated_at_unix_ms = now_unix_ms();
        Some((
            inner.changed(),
            DisconnectedSerial {
                entry: before_entry,
                connected_at,
            },
        ))
    }

    /// Puts back a disconnect the lighting refused, in its old place in the connect order — unless the
    /// port was connected again since, which is newer than what this would restore.
    pub fn restore_serial(&self, previous: DisconnectedSerial) -> Option<LocalOutputsSnapshot> {
        let mut inner = self.lock();
        let port = previous.entry.port_name.clone();
        if inner.serial.get(&port).is_some_and(|entry| entry.connected) {
            return None;
        }
        inner
            .serial_connected_at
            .insert(port.clone(), previous.connected_at);
        inner.serial.insert(port, previous.entry);
        Some(inner.changed())
    }

    /// Shutdown: nothing is driven any more.
    pub fn clear(&self) {
        let mut inner = self.lock();
        inner.wled = None;
        inner.release_all_serial("shutdown");
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

    #[cfg(test)]
    pub fn connected_serial_port(&self) -> Option<String> {
        self.lock()
            .serial
            .values()
            .find(|entry| entry.connected)
            .map(|entry| entry.port_name.clone())
    }

    /// Every connected serial port: the watcher checks each one on every poll.
    pub fn connected_serial_ports(&self) -> Vec<String> {
        self.lock()
            .serial
            .values()
            .filter(|entry| entry.connected)
            .map(|entry| entry.port_name.clone())
            .collect()
    }

    pub fn wled_config(&self) -> Option<WledSinkConfig> {
        self.lock().wled
    }

    pub fn snapshot(&self) -> LocalOutputsSnapshot {
        self.lock().snapshot()
    }

    /// Test rigs: `port` connected (or merely named, `connected: false`) without a real connect.
    #[cfg(test)]
    pub fn set_serial_for_tests(&self, port: &str, connected: bool, updated_at_unix_ms: u128) {
        if connected {
            self.serial_connected(SerialConnectionStatus {
                port_name: Some(port.to_string()),
                connected,
                status: command_status("CONNECT_OK", "test", None),
                updated_at_unix_ms,
                firmware: None,
            });
        } else {
            let mut inner = self.lock();
            inner.serial.insert(
                port.to_string(),
                SerialOutputStatus {
                    port_name: port.to_string(),
                    connected: false,
                    status: disconnected_status("test", None),
                    firmware: None,
                    updated_at_unix_ms,
                },
            );
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

    let registry = app.state::<LocalOutputRegistry>();
    // Marked first, so the lighting re-plans onto what remains rather than onto this port again.
    let Some((snapshot, previous)) = registry.serial_disconnected(port) else {
        return disconnect_result(
            port,
            "SERIAL_DISCONNECT_NOT_CONNECTED",
            "That strip is not connected.",
            None,
        );
    };
    announce(app, snapshot);

    if let Err(error) = let_go(app, &Left::Serial(port.to_string())).await {
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
    log::info!("[serial-disconnect] {port} disconnected");
    disconnect_result(
        port,
        "SERIAL_DISCONNECT_OK",
        "The strip was disconnected.",
        None,
    )
}

/// A local output that stopped being connected, for `let_go`.
pub(crate) enum Left {
    Serial(String),
    Wled(WledSinkConfig),
}

/// Runs after `left` stopped being connected in the registry. A mode writing to it moves onto what
/// remains — the earliest connected output — or, with nothing left, drops `usb` as an unplug does
/// (session only; a mode it ran alone ends as Off does). Then a strip it lit is painted black — a
/// strip holds its last frame, a Solid colour indefinitely — and a WLED device it lit is switched
/// off. `Err` when the lighting still writes to `left`.
pub(crate) async fn let_go<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    left: &Left,
) -> Result<(), String> {
    use super::lighting_mode::outputs::{
        apply_outputs_with, power_off_left_wled, refresh_running_with, ApplyOutputsRequest,
        LightingOrigin,
    };
    use super::lighting_mode::snapshot::OutputTarget;
    use super::lighting_mode::LightingRuntimeState;
    use tauri::Manager;

    let registry = app.state::<LocalOutputRegistry>();
    let lighting = app.state::<LightingRuntimeState>();
    let drives = |lighting: &LightingRuntimeState| match left {
        Left::Serial(port) => lighting.drives_serial(port),
        Left::Wled(config) => lighting.drives_wled(config.ip),
    };
    let drove = drives(&lighting);
    let before = lighting.snapshot.read();

    if drove {
        let moved = if registry.driven().is_some() {
            refresh_running_with(app).await.map(|_| ())
        } else {
            let rest = before
                .selected_targets
                .iter()
                .filter(|target| **target != OutputTarget::Usb)
                .map(|target| target.as_str().to_string())
                .collect();
            let request = ApplyOutputsRequest {
                mode: None,
                targets: Some(rest),
                origin: LightingOrigin::UsbUnplug,
            };
            apply_outputs_with(app, request).await.map(|_| ())
        };
        moved?;
        // A refusal can answer `Ok` too: what counts is whether the output is still written to.
        if drives(&lighting) {
            return Err("the running mode still drives it".to_string());
        }
    }

    // The black frame and the session drop block on the port (a dead session retries, a stuck writer
    // is waited out): off the async runtime, as every other blank is.
    let ended = before.mode.clone();
    match left {
        Left::Serial(port) => {
            // Moving onto another strip already painted it black through its session. With nothing
            // left, no apply reached `set_active_port`, so the runtime still names this port: that
            // stale record is what tells the blank below to run.
            let blank = drove && lighting.holds_port(port);
            let port = port.clone();
            let handle = app.clone();
            let released = tauri::async_runtime::spawn_blocking(move || {
                if blank {
                    if let Err(reason) =
                        super::lighting_mode::transition::blank_serial_port(&handle, &port, &ended)
                    {
                        log::warn!("[let-go] {port} kept its last frame: {reason}");
                    }
                }
                // A connect of the same port meanwhile owns the cached writer now.
                let registry = handle.state::<LocalOutputRegistry>();
                if !registry.connected_serial_ports().contains(&port) {
                    handle
                        .state::<LightingRuntimeState>()
                        .forget_serial_session(&port);
                }
            })
            .await;
            if let Err(error) = released {
                log::warn!("[let-go] releasing the port did not run: {error}");
            }
        }
        Left::Wled(config) => {
            if drove {
                let config = *config;
                let handle = app.clone();
                let blanked = tauri::async_runtime::spawn_blocking(move || {
                    super::lighting_mode::transition::blank_wled(&handle, config, &ended)
                })
                .await
                .unwrap_or_else(|error| Err(error.to_string()));
                if let Err(reason) = blanked {
                    log::warn!("[let-go] WLED {} kept its last frame: {reason}", config.ip);
                }
                power_off_left_wled(app, config.ip).await;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "local_outputs_tests.rs"]
mod tests;
