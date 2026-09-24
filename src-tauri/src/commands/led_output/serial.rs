//! The serial transport: the coded error, the packet sender behind the
//! bridge, the per-port writer thread that keeps the worker off the port, and
//! `LedOutputBridge`.

use std::collections::HashMap;
use std::io::Write;
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

#[cfg(test)]
use crate::commands::device_connection::SerialConnectionState;
use crate::commands::device_connection::BOOTLOADER_SETTLE_DELAY_MS;
use crate::commands::led_calibration::wire_duration;

const OUTPUT_BAUD_RATE: u32 = 115_200;
const OUTPUT_TIMEOUT_MS: u64 = 500;

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

/// Coded failure from the serial output layer — `code` is the stable
/// machine identifier surfaced across the Tauri IPC boundary, `details` is
/// optional human context for logs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LedOutputError {
    pub code: &'static str,
    pub details: Option<String>,
}

impl LedOutputError {
    pub(super) fn new(code: &'static str, details: Option<String>) -> Self {
        Self { code, details }
    }

    /// Render as the `CODE` or `CODE: details` string used in coded error responses.
    pub fn as_reason(&self) -> String {
        match &self.details {
            Some(details) => format!("{}: {}", self.code, details),
            None => self.code.to_string(),
        }
    }
}

// ---------------------------------------------------------------------------
// LedPacketSender trait + SerialLedPacketSender
// ---------------------------------------------------------------------------

/// Low-level write abstraction behind `LedOutputBridge`, so the bridge and
/// its callers can be tested without opening a real serial port.
pub trait LedPacketSender: Send + Sync {
    /// Hand `packet` over for writing. The serial implementation returns before
    /// the bytes are on the wire; a write that fails is reported by the next
    /// call for the same port.
    fn send(&self, port_name: &str, packet: &[u8]) -> Result<(), LedOutputError>;
    /// Like `send`, but returns once this packet has left the host, so a
    /// one-shot write (Solid) reports its own outcome.
    fn send_and_wait(&self, port_name: &str, packet: &[u8]) -> Result<(), LedOutputError> {
        self.send(port_name, packet)
    }
    /// Block until everything queued for `port_name` has been handled.
    #[cfg(test)]
    fn wait_idle(&self, _port_name: &str) {}
    /// Drop the cached writer for `port_name`. Called by `set_active_port`
    /// (lighting_mode/transition.rs) when the active port switches to a different one,
    /// so the abandoned port's OS handle is released instead of staying open
    /// until the app quits. Never called for a same-port overwrite — that
    /// would reopen the port and toggle DTR — see
    /// docs/architecture/device-output.md (DTR reset).
    fn disconnect_session(&self, port_name: &str);
}

type PortFactory = dyn Fn(&str) -> Result<Box<dyn Write + Send>, LedOutputError> + Send + Sync;

/// How long a writer waits, after starting a packet of this many bytes,
/// before it starts the next one.
pub(super) type WriterPacing = fn(usize) -> Duration;

/// Paces a little under the nominal 11 520 bytes/s, so an adapter that clocks
/// slightly slow never lets a backlog build in the OS buffer.
const WRITER_PACING_MARGIN_PERCENT: u32 = 2;

pub(super) fn link_pacing(packet_len: usize) -> Duration {
    wire_duration(packet_len) * (100 + WRITER_PACING_MARGIN_PERCENT) / 100
}

/// How long dropping a session waits for its writer to exit. A write already
/// in progress finishes or hits `OUTPUT_TIMEOUT_MS` first; past this bound the
/// writer is detached rather than stalling the caller.
pub(super) const WRITER_EXIT_TIMEOUT: Duration = Duration::from_millis(OUTPUT_TIMEOUT_MS + 100);

/// What `send_and_wait` allows beyond its packet's wire time: a pacing wait for
/// the packet before it, then the write and the drain, each bounded by the
/// port timeout.
const CONFIRM_SLACK: Duration = Duration::from_millis(3 * OUTPUT_TIMEOUT_MS);

/// State shared between a session and its writer thread. `packet` is a
/// latest-wins slot: a send overwrites whatever the writer has not taken yet.
#[derive(Default)]
struct WriterSlot {
    packet: Vec<u8>,
    pending: bool,
    queued: u64,
    written: u64,
    /// Packets up to this sequence number are drained after writing.
    drain_through: u64,
    failure: Option<LedOutputError>,
    closing: bool,
    exited: bool,
}

#[derive(Default)]
struct WriterShared {
    slot: Mutex<WriterSlot>,
    changed: Condvar,
}

impl WriterShared {
    fn lock(&self) -> std::sync::MutexGuard<'_, WriterSlot> {
        self.slot
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Wait until the writer has finished packet `seq` (or a newer one).
    fn wait_written(&self, seq: u64, timeout: Duration) -> Result<(), LedOutputError> {
        let deadline = Instant::now() + timeout;
        let mut slot = self.lock();
        loop {
            if let Some(failure) = &slot.failure {
                return Err(failure.clone());
            }
            if slot.written >= seq {
                return Ok(());
            }
            let now = Instant::now();
            if slot.exited || now >= deadline {
                return Err(LedOutputError::new(
                    "LED_OUTPUT_WRITE_FAILED",
                    Some(format!(
                        "The serial writer did not finish the packet within {} ms.",
                        timeout.as_millis()
                    )),
                ));
            }
            slot = self
                .changed
                .wait_timeout(slot, deadline - now)
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .0;
        }
    }
}

/// One open port and the thread that writes to it. See
/// docs/architecture/device-output.md, "The serial write never blocks the worker".
struct WriterSession {
    shared: Arc<WriterShared>,
    thread: Option<JoinHandle<()>>,
}

impl WriterSession {
    fn spawn(port: Box<dyn Write + Send>, pacing: WriterPacing) -> Result<Self, LedOutputError> {
        let shared = Arc::new(WriterShared::default());
        let for_thread = Arc::clone(&shared);
        let thread = std::thread::Builder::new()
            .name("lumasync-serial-writer".into())
            .spawn(move || run_writer(port, &for_thread, pacing))
            .map_err(|error| {
                LedOutputError::new("LED_OUTPUT_PORT_UNAVAILABLE", Some(error.to_string()))
            })?;
        Ok(Self {
            shared,
            thread: Some(thread),
        })
    }

    /// Replace the pending packet, or report the failure that ended the writer.
    /// Copies into a buffer the writer hands back, so it does not allocate once
    /// both buffers have grown to the frame size.
    fn queue(&self, packet: &[u8], drain: bool) -> Result<u64, LedOutputError> {
        let mut slot = self.shared.lock();
        if let Some(failure) = &slot.failure {
            return Err(failure.clone());
        }
        if slot.exited {
            return Err(LedOutputError::new(
                "LED_OUTPUT_PORT_UNAVAILABLE",
                Some("The serial writer has stopped.".to_string()),
            ));
        }
        slot.packet.clear();
        slot.packet.extend_from_slice(packet);
        slot.pending = true;
        slot.queued += 1;
        let seq = slot.queued;
        if drain {
            slot.drain_through = seq;
        }
        drop(slot);
        self.shared.changed.notify_all();
        Ok(seq)
    }

    #[cfg(test)]
    fn wait_idle(&self) {
        let seq = self.shared.lock().queued;
        let _ = self.shared.wait_written(seq, Duration::from_secs(5));
    }
}

impl Drop for WriterSession {
    fn drop(&mut self) {
        self.shared.lock().closing = true;
        self.shared.changed.notify_all();

        let deadline = Instant::now() + WRITER_EXIT_TIMEOUT;
        let mut slot = self.shared.lock();
        while !slot.exited {
            let now = Instant::now();
            if now >= deadline {
                break;
            }
            slot = self
                .shared
                .changed
                .wait_timeout(slot, deadline - now)
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .0;
        }
        let exited = slot.exited;
        drop(slot);

        if let Some(thread) = self.thread.take() {
            if exited {
                let _ = thread.join();
            } else {
                log::warn!(
                    "[serial-writer] writer still inside a write after {}ms; detached",
                    WRITER_EXIT_TIMEOUT.as_millis()
                );
            }
        }
    }
}

/// The writer thread: takes the newest packet, writes it, then waits out its
/// wire time before taking another, so the OS buffer never holds a backlog.
fn run_writer(mut port: Box<dyn Write + Send>, shared: &WriterShared, pacing: WriterPacing) {
    let mut packet = Vec::new();
    let mut next_write_at = Instant::now();
    let failure = loop {
        let (seq, drain) = {
            let mut slot = shared.lock();
            loop {
                if slot.closing {
                    break;
                }
                let now = Instant::now();
                if slot.pending && now >= next_write_at {
                    break;
                }
                slot = if slot.pending {
                    shared
                        .changed
                        .wait_timeout(slot, next_write_at - now)
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .0
                } else {
                    shared
                        .changed
                        .wait(slot)
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                };
            }
            if slot.closing {
                break None;
            }
            std::mem::swap(&mut packet, &mut slot.packet);
            slot.pending = false;
            (slot.queued, slot.queued <= slot.drain_through)
        };

        let started = Instant::now();
        let mut result = port.write_all(&packet).map_err(|error| {
            LedOutputError::new("LED_OUTPUT_WRITE_FAILED", Some(error.to_string()))
        });
        if drain && result.is_ok() {
            result = port.flush().map_err(|error| {
                LedOutputError::new("LED_OUTPUT_FLUSH_FAILED", Some(error.to_string()))
            });
        }
        // A drained packet is already off the wire; anything else is still
        // shifting out for its wire time from when it started.
        next_write_at = if drain {
            Instant::now()
        } else {
            started + pacing(packet.len())
        };

        let mut slot = shared.lock();
        slot.written = seq;
        if let Err(error) = result {
            drop(slot);
            break Some(error);
        }
        drop(slot);
        shared.changed.notify_all();
    };

    // Closed before `exited` is published, so a reopen right after a
    // disconnect does not find the port still held.
    drop(port);
    let mut slot = shared.lock();
    slot.failure = failure;
    slot.exited = true;
    drop(slot);
    shared.changed.notify_all();
}

pub(super) struct SerialLedPacketSender {
    sessions: Mutex<HashMap<String, WriterSession>>,
    port_factory: Arc<PortFactory>,
    /// Runs once per newly opened handle, before its first byte. Separate from
    /// `port_factory` so tests can observe *when* it fires without sleeping.
    after_open: Arc<dyn Fn() + Send + Sync>,
    pacing: WriterPacing,
}

impl SerialLedPacketSender {
    fn new(
        port_factory: Arc<PortFactory>,
        after_open: Arc<dyn Fn() + Send + Sync>,
        pacing: WriterPacing,
    ) -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            port_factory,
            after_open,
            pacing,
        }
    }

    #[cfg(test)]
    pub(super) fn with_port_factory_for_tests<F>(factory: F) -> Self
    where
        F: Fn(&str) -> Result<Box<dyn Write + Send>, LedOutputError> + Send + Sync + 'static,
    {
        Self::new(Arc::new(factory), Arc::new(|| {}), |_| Duration::ZERO)
    }

    #[cfg(test)]
    pub(super) fn with_open_hook_for_tests<F, H>(factory: F, after_open: H) -> Self
    where
        F: Fn(&str) -> Result<Box<dyn Write + Send>, LedOutputError> + Send + Sync + 'static,
        H: Fn() + Send + Sync + 'static,
    {
        Self::new(Arc::new(factory), Arc::new(after_open), |_| Duration::ZERO)
    }

    #[cfg(test)]
    pub(super) fn with_pacing_for_tests<F>(factory: F, pacing: WriterPacing) -> Self
    where
        F: Fn(&str) -> Result<Box<dyn Write + Send>, LedOutputError> + Send + Sync + 'static,
    {
        Self::new(Arc::new(factory), Arc::new(|| {}), pacing)
    }

    fn lock_sessions(
        &self,
    ) -> Result<std::sync::MutexGuard<'_, HashMap<String, WriterSession>>, LedOutputError> {
        self.sessions.lock().map_err(|error| {
            LedOutputError::new("LED_OUTPUT_SESSION_LOCK_FAILED", Some(error.to_string()))
        })
    }

    /// Queue `packet` on the port's writer, opening the port first if needed.
    /// A writer that has failed is removed here, so the error reaches the
    /// caller once and the next send reopens the port.
    fn queue(
        &self,
        port_name: &str,
        packet: &[u8],
        drain: bool,
    ) -> Result<(Arc<WriterShared>, u64), LedOutputError> {
        let mut sessions = self.lock_sessions()?;

        if !sessions.contains_key(port_name) {
            let opened = (self.port_factory)(port_name)?;
            (self.after_open)();
            let session = WriterSession::spawn(opened, self.pacing)?;
            sessions.insert(port_name.to_string(), session);
        }

        let Some(session) = sessions.get(port_name) else {
            return Err(LedOutputError::new(
                "LED_OUTPUT_PORT_UNAVAILABLE",
                Some("Port session could not be created for output write.".to_string()),
            ));
        };

        match session.queue(packet, drain) {
            Ok(seq) => Ok((Arc::clone(&session.shared), seq)),
            Err(error) => {
                let dead = sessions.remove(port_name);
                drop(sessions);
                drop(dead);
                Err(error)
            }
        }
    }

    /// Remove `port_name`'s session if it is still the one behind `shared`.
    fn remove_if_current(&self, port_name: &str, shared: &Arc<WriterShared>) {
        let removed = self.lock_sessions().ok().and_then(|mut sessions| {
            let current = sessions
                .get(port_name)
                .is_some_and(|session| Arc::ptr_eq(&session.shared, shared));
            current.then(|| sessions.remove(port_name)).flatten()
        });
        drop(removed);
    }
}

impl Default for SerialLedPacketSender {
    fn default() -> Self {
        Self::new(
            Arc::new(|port_name: &str| {
                serialport::new(port_name, OUTPUT_BAUD_RATE)
                    .timeout(Duration::from_millis(OUTPUT_TIMEOUT_MS))
                    .open()
                    .map(|port| port as Box<dyn Write + Send>)
                    .map_err(|error| {
                        LedOutputError::new("LED_OUTPUT_PORT_OPEN_FAILED", Some(error.to_string()))
                    })
            }),
            // Connect opens, settles, verifies and then *drops* its handle, so
            // this open is a second DTR assert and a second auto-reset. Frame 1
            // is written into the bootloader without it.
            Arc::new(|| {
                std::thread::sleep(Duration::from_millis(BOOTLOADER_SETTLE_DELAY_MS));
            }),
            link_pacing,
        )
    }
}

impl LedPacketSender for SerialLedPacketSender {
    fn send(&self, port_name: &str, packet: &[u8]) -> Result<(), LedOutputError> {
        self.queue(port_name, packet, false).map(|_| ())
    }

    fn send_and_wait(&self, port_name: &str, packet: &[u8]) -> Result<(), LedOutputError> {
        let (shared, seq) = self.queue(port_name, packet, true)?;
        let result = shared.wait_written(seq, wire_duration(packet.len()) + CONFIRM_SLACK);
        if result.is_err() {
            self.remove_if_current(port_name, &shared);
        }
        result
    }

    #[cfg(test)]
    fn wait_idle(&self, port_name: &str) {
        let sessions = self.sessions.lock().expect("sessions lock");
        if let Some(session) = sessions.get(port_name) {
            session.wait_idle();
        }
    }

    fn disconnect_session(&self, port_name: &str) {
        let removed = self
            .lock_sessions()
            .ok()
            .and_then(|mut sessions| sessions.remove(port_name));
        drop(removed);
    }
}

// ---------------------------------------------------------------------------
// LedOutputBridge
// ---------------------------------------------------------------------------

/// Owns the serial packet sender and exposes the encode-agnostic write path
/// shared by the Solid and Ambilight runtimes and by `SerialSink`.
#[derive(Clone)]
pub struct LedOutputBridge {
    sender: Arc<dyn LedPacketSender>,
}

impl LedOutputBridge {
    /// Build a bridge backed by the real `serialport` crate.
    pub fn new() -> Self {
        Self {
            sender: Arc::new(SerialLedPacketSender::default()),
        }
    }

    /// Build a bridge over an injected sender, for tests that need to
    /// observe writes without opening a real port.
    #[cfg(test)]
    pub fn from_sender(sender: Arc<dyn LedPacketSender>) -> Self {
        Self { sender }
    }

    /// The production serial writer over injected ports, unpaced and unsettled.
    #[cfg(test)]
    pub fn with_serial_writer_for_tests<F>(factory: F) -> Self
    where
        F: Fn(&str) -> Result<Box<dyn Write + Send>, LedOutputError> + Send + Sync + 'static,
    {
        Self {
            sender: Arc::new(SerialLedPacketSender::with_port_factory_for_tests(factory)),
        }
    }

    #[cfg(test)]
    pub fn wait_idle_for_tests(&self, port_name: &str) {
        self.sender.wait_idle(port_name);
    }

    /// Drop the cached port handle for `port_name`. `SerialSink::stop` still
    /// never calls this on a same-port transition — see the rationale
    /// comment there — but `set_active_port` (lighting_mode/transition.rs) calls it
    /// when the active port switches to a different one, and a failed write
    /// still drops its dead handle on the next `SerialLedPacketSender::send`.
    pub fn disconnect_session(&self, port_name: &str) {
        self.sender.disconnect_session(port_name);
    }

    /// Look up the currently connected port from `connection_state` and
    /// write `packet` to it. Test-only convenience over `send_packet_to_port`.
    #[cfg(test)]
    pub fn send_packet(
        &self,
        connection_state: &SerialConnectionState,
        packet: &[u8],
    ) -> Result<(), LedOutputError> {
        let status = connection_state
            .last_status
            .lock()
            .map_err(|error| {
                LedOutputError::new(
                    "LED_OUTPUT_CONNECTION_STATE_LOCK_FAILED",
                    Some(error.to_string()),
                )
            })?
            .clone();

        if !status.connected {
            return Err(LedOutputError::new(
                "LED_OUTPUT_DEVICE_NOT_CONNECTED",
                Some("Last known device state is disconnected.".to_string()),
            ));
        }

        let port_name = status.port_name.ok_or_else(|| {
            LedOutputError::new(
                "LED_OUTPUT_PORT_UNAVAILABLE",
                Some("No connected serial port is recorded in connection state.".to_string()),
            )
        })?;

        self.send_packet_to_port(&port_name, packet)
    }

    /// Write `packet` to `port_name`, opening or reusing a cached session on
    /// the underlying sender as needed.
    pub fn send_packet_to_port(
        &self,
        port_name: &str,
        packet: &[u8],
    ) -> Result<(), LedOutputError> {
        self.sender.send(port_name, packet)
    }

    /// `send_packet_to_port` for a one-shot write: returns once the packet has
    /// left the host, with that write's own outcome.
    pub fn send_packet_to_port_and_wait(
        &self,
        port_name: &str,
        packet: &[u8],
    ) -> Result<(), LedOutputError> {
        self.sender.send_and_wait(port_name, packet)
    }
}

impl Default for LedOutputBridge {
    fn default() -> Self {
        Self::new()
    }
}
