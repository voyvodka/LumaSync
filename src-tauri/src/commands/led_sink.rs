/// `LedSink` trait — the single output abstraction for all LED destinations.
///
/// Implemented by `SerialSink` (USB serial) and by `WledUdpSink` /
/// `CorrectedWledSink` (WLED over DDP/WARLS UDP).
///
/// Design rules (docs/architecture/device-output.md):
///   - One active sink per output channel.
///   - Hue + USB are separate channels and may run simultaneously.
///   - Never change the on-wire format silently; format changes are user-visible
///     "Firmware profile" migrations.
///
/// The trait is synchronous (no `async_trait` dependency). Hot-path callers
/// live on a dedicated worker thread and can use `std::thread::spawn` +
/// `std::sync::mpsc` if a sink needs to offload I/O; the trait itself stays
/// sync to avoid pulling in `tokio` into the serialport layer.
pub trait LedSink: Send + Sync {
    /// Prepare the sink for streaming. Called once before the first
    /// `send_frame`. May open a port, resolve a UDP endpoint, etc.
    /// A second call after a successful `start` is a no-op (idempotent).
    fn start(&mut self) -> Result<(), String>;

    /// Send one LED frame. `colors` is in strip order (index 0 = first LED).
    ///
    /// The callee is responsible for encoding (gamma LUT, packet framing,
    /// checksum). Returning `Err` signals a transient I/O error; the worker
    /// may retry or stop depending on the retry policy.
    fn send_frame(&mut self, colors: &[[u8; 3]]) -> Result<(), String>;

    /// Tear down the sink. Must be safe to call even when `start` was never
    /// called, or after a previous `stop`. Idempotent.
    fn stop(&mut self) -> Result<(), String>;
}
