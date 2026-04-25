/// `LedSink` trait — the single output abstraction for all LED destinations.
///
/// v1.4: `SerialSink` is the only implementation.
/// v1.5: `WledUdpSink` will implement this trait over DDP/WARLS UDP.
/// v2.0: `OpenRgbClientSink` will implement this over TCP port 6742.
///
/// Design rule (from `ls-led-protocols`):
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
    /// Human-readable sink name, e.g. `"serial"`, `"wled-udp"`.
    ///
    /// Used for logging and diagnostics. Future sinks (WLED, OpenRGB) will
    /// surface this in the UI. `#[allow(dead_code)]` because `SerialSink` is
    /// the only impl today and its `name()` is only exercised by tests; the
    /// trait method must remain in the surface for v1.5+ impls.
    #[allow(dead_code)]
    fn name(&self) -> &'static str;

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

#[cfg(test)]
mod tests {
    use super::LedSink;
    use std::sync::Mutex;

    // ---------------------------------------------------------------------------
    // Mock sink — write-count + disconnect validation
    // ---------------------------------------------------------------------------

    struct MockSink {
        started: bool,
        stopped: bool,
        frames_sent: usize,
        last_frame: Vec<[u8; 3]>,
        fail_send: bool,
    }

    impl MockSink {
        fn new() -> Self {
            Self {
                started: false,
                stopped: false,
                frames_sent: 0,
                last_frame: Vec::new(),
                fail_send: false,
            }
        }

        fn failing() -> Self {
            Self {
                fail_send: true,
                ..Self::new()
            }
        }
    }

    impl LedSink for MockSink {
        fn name(&self) -> &'static str {
            "mock"
        }

        fn start(&mut self) -> Result<(), String> {
            self.started = true;
            Ok(())
        }

        fn send_frame(&mut self, colors: &[[u8; 3]]) -> Result<(), String> {
            if self.fail_send {
                return Err("MOCK_SEND_FAILED".to_string());
            }
            self.frames_sent += 1;
            self.last_frame = colors.to_vec();
            Ok(())
        }

        fn stop(&mut self) -> Result<(), String> {
            self.stopped = true;
            Ok(())
        }
    }

    #[test]
    fn mock_sink_lifecycle_start_send_stop() {
        let mut sink = MockSink::new();
        sink.start().expect("start should succeed");
        assert!(sink.started);

        let frame = [[10_u8, 20, 30], [40, 50, 60]];
        sink.send_frame(&frame).expect("send should succeed");
        assert_eq!(sink.frames_sent, 1);
        assert_eq!(sink.last_frame, frame.to_vec());

        sink.stop().expect("stop should succeed");
        assert!(sink.stopped);
    }

    #[test]
    fn mock_sink_send_failure_propagates_error_code() {
        let mut sink = MockSink::failing();
        sink.start().unwrap();
        let err = sink.send_frame(&[[1, 2, 3]]).expect_err("send should fail");
        assert_eq!(err, "MOCK_SEND_FAILED");
        assert_eq!(sink.frames_sent, 0);
    }

    #[test]
    fn mock_sink_stop_is_idempotent() {
        let mut sink = MockSink::new();
        sink.stop().expect("first stop should succeed");
        sink.stop().expect("second stop should also succeed");
    }

    #[test]
    fn led_sink_is_object_safe_via_box() {
        // Verify the trait is object-safe; this would be a compile error otherwise.
        let mut sink: Box<dyn LedSink> = Box::new(MockSink::new());
        sink.start().unwrap();
        sink.send_frame(&[[1, 2, 3]]).unwrap();
        sink.stop().unwrap();
        assert_eq!(sink.name(), "mock");
    }

    #[test]
    fn mock_sink_write_count_increments_per_send() {
        let mut sink = MockSink::new();
        sink.start().unwrap();
        for _ in 0..5 {
            sink.send_frame(&[[0, 0, 0]]).unwrap();
        }
        assert_eq!(sink.frames_sent, 5);
    }

    #[test]
    fn mock_sink_last_frame_reflects_most_recent_send() {
        let mut sink = MockSink::new();
        sink.start().unwrap();
        sink.send_frame(&[[1, 1, 1]]).unwrap();
        sink.send_frame(&[[99, 88, 77], [11, 22, 33]]).unwrap();
        assert_eq!(sink.last_frame, vec![[99_u8, 88, 77], [11, 22, 33]]);
    }

    // Demonstrate that a LedSink can be shared across threads via Arc<Mutex<...>>
    // (v1.5 WLED sink will use this pattern for UDP socket ownership).
    #[test]
    fn led_sink_arc_mutex_wrapper_is_thread_safe() {
        use std::sync::Arc;
        use std::thread;

        let sink = Arc::new(Mutex::new(MockSink::new()));
        {
            sink.lock().unwrap().start().unwrap();
        }

        let sink_clone = Arc::clone(&sink);
        let handle = thread::spawn(move || {
            sink_clone.lock().unwrap().send_frame(&[[1, 2, 3]]).unwrap();
        });
        handle.join().unwrap();

        let guard = sink.lock().unwrap();
        assert_eq!(guard.frames_sent, 1);
    }
}
