//! The bridge, the packet sender, and the writer thread that keeps the caller
//! off the port.

use std::io::Write;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use super::encode::{apply_solid_payload, encode_led_packet, send_ambilight_frame};
use super::serial::{LedOutputBridge, LedOutputError, LedPacketSender};
use super::test_support::{connected_state, FakePort, FakeSender};

// ---------------------------------------------------------------------------
// Bridge / sender
// ---------------------------------------------------------------------------

#[test]
fn bridge_uses_connected_port_and_returns_coded_write_error() {
    let success_sender = Arc::new(FakeSender::successful());
    let success_bridge = LedOutputBridge::from_sender(success_sender.clone());
    let state = connected_state("COM9");

    apply_solid_payload(&success_bridge, &state, 1, 2, 3, 1.0)
        .expect("successful write should not error");
    assert_eq!(success_sender.writes().len(), 1);
    assert_eq!(success_sender.writes()[0].0, "COM9");

    let failing_sender = Arc::new(FakeSender::failing("LED_OUTPUT_WRITE_FAILED"));
    let failing_bridge = LedOutputBridge::from_sender(failing_sender);
    let error = apply_solid_payload(&failing_bridge, &state, 1, 2, 3, 1.0)
        .expect_err("write failure should bubble up");
    assert_eq!(error.code, "LED_OUTPUT_WRITE_FAILED");
}

#[test]
fn ambilight_frame_uses_same_packet_rules_as_solid() {
    let sender = Arc::new(FakeSender::successful());
    let bridge = LedOutputBridge::from_sender(sender.clone());
    let state = connected_state("COM7");

    let frame = [[10, 20, 30], [5, 15, 25]];
    send_ambilight_frame(&bridge, &state, &frame, 0.25).expect("frame send should succeed");

    let writes = sender.writes();
    assert_eq!(writes.len(), 1);
    assert_eq!(writes[0].1, encode_led_packet(0.25, &frame));
}

#[test]
fn serial_sender_reuses_open_port_for_repeated_hot_path_writes() {
    let open_count = Arc::new(AtomicUsize::new(0));
    let open_count_for_factory = Arc::clone(&open_count);
    let sender =
        super::serial::SerialLedPacketSender::with_port_factory_for_tests(move |_port_name| {
            open_count_for_factory.fetch_add(1, Ordering::SeqCst);
            Ok(Box::new(FakePort::default()))
        });

    sender.send("COM42", &[1, 2, 3]).expect("first write");
    sender
        .send("COM42", &[4, 5, 6])
        .expect("second write reuses session");
    assert_eq!(open_count.load(Ordering::SeqCst), 1);
}

#[test]
fn first_frame_settles_before_the_bootloader_gets_the_bytes() {
    // Connect opens, settles, verifies and drops its handle, so this open is
    // a second DTR assert. Without the settle frame 1 lands in the bootloader.
    let settles = Arc::new(AtomicUsize::new(0));
    let settles_for_hook = Arc::clone(&settles);
    let sender = super::serial::SerialLedPacketSender::with_open_hook_for_tests(
        |_port_name| Ok(Box::new(FakePort::default())),
        move || {
            settles_for_hook.fetch_add(1, Ordering::SeqCst);
        },
    );

    sender.send("COM42", &[1, 2, 3]).expect("first write");
    assert_eq!(settles.load(Ordering::SeqCst), 1);
}

#[test]
fn the_settle_is_per_session_not_per_frame() {
    // The 2 s cost is only acceptable once. Paying it per frame would put the
    // capture-to-output path 40x over its budget.
    let settles = Arc::new(AtomicUsize::new(0));
    let settles_for_hook = Arc::clone(&settles);
    let sender = super::serial::SerialLedPacketSender::with_open_hook_for_tests(
        |_port_name| Ok(Box::new(FakePort::default())),
        move || {
            settles_for_hook.fetch_add(1, Ordering::SeqCst);
        },
    );

    for _ in 0..5 {
        sender.send("COM42", &[1, 2, 3]).expect("write");
    }
    assert_eq!(settles.load(Ordering::SeqCst), 1);

    // A reopen is a fresh DTR assert, so it settles again.
    sender.disconnect_session("COM42");
    sender
        .send("COM42", &[4, 5, 6])
        .expect("write after reopen");
    assert_eq!(settles.load(Ordering::SeqCst), 2);
}

#[test]
fn a_failed_open_does_not_settle() {
    let settles = Arc::new(AtomicUsize::new(0));
    let settles_for_hook = Arc::clone(&settles);
    let sender = super::serial::SerialLedPacketSender::with_open_hook_for_tests(
        |_port_name| Err(LedOutputError::new("LED_OUTPUT_PORT_OPEN_FAILED", None)),
        move || {
            settles_for_hook.fetch_add(1, Ordering::SeqCst);
        },
    );

    assert!(sender.send("COM42", &[1, 2, 3]).is_err());
    assert_eq!(settles.load(Ordering::SeqCst), 0);
}

#[test]
fn disconnect_session_removes_cached_handle_and_forces_reopen() {
    let open_count = Arc::new(AtomicUsize::new(0));
    let open_count_for_factory = Arc::clone(&open_count);
    let sender =
        super::serial::SerialLedPacketSender::with_port_factory_for_tests(move |_port_name| {
            open_count_for_factory.fetch_add(1, Ordering::SeqCst);
            Ok(Box::new(FakePort::default()))
        });

    sender.send("COM42", &[1, 2, 3]).expect("first write");
    assert_eq!(
        open_count.load(Ordering::SeqCst),
        1,
        "one open after first send"
    );

    sender.disconnect_session("COM42");

    sender
        .send("COM42", &[4, 5, 6])
        .expect("send after disconnect reopens");
    assert_eq!(
        open_count.load(Ordering::SeqCst),
        2,
        "port must be reopened after disconnect_session"
    );
}

// ---------------------------------------------------------------------------
// The writer thread: the caller never waits on the port
// ---------------------------------------------------------------------------

/// What a scripted port saw, shared with the test after the port has moved
/// onto the writer thread.
#[derive(Default)]
struct PortLog {
    writes: Mutex<Vec<(Instant, Vec<u8>)>>,
    writes_started: AtomicUsize,
    flushes: AtomicUsize,
    dropped: AtomicBool,
}

impl PortLog {
    fn packets(&self) -> Vec<Vec<u8>> {
        let writes = self.writes.lock().expect("writes lock");
        writes.iter().map(|(_, packet)| packet.clone()).collect()
    }

    fn write_times(&self) -> Vec<Instant> {
        let writes = self.writes.lock().expect("writes lock");
        writes.iter().map(|(at, _)| *at).collect()
    }
}

#[derive(Clone, Copy, Default)]
struct PortScript {
    write_takes: Duration,
    fail_writes: bool,
    fail_flushes: bool,
}

struct ScriptedPort {
    log: Arc<PortLog>,
    script: PortScript,
}

impl Write for ScriptedPort {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let started = Instant::now();
        self.log.writes_started.fetch_add(1, Ordering::SeqCst);
        std::thread::sleep(self.script.write_takes);
        if self.script.fail_writes {
            return Err(std::io::ErrorKind::BrokenPipe.into());
        }
        self.log
            .writes
            .lock()
            .expect("writes lock")
            .push((started, buf.to_vec()));
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.log.flushes.fetch_add(1, Ordering::SeqCst);
        if self.script.fail_flushes {
            return Err(std::io::ErrorKind::TimedOut.into());
        }
        Ok(())
    }
}

impl Drop for ScriptedPort {
    fn drop(&mut self) {
        self.log.dropped.store(true, Ordering::SeqCst);
    }
}

/// A sender over scripted ports. Every open gets a fresh port with the same
/// script; the returned logs are per open, in order.
fn scripted_sender(
    script: PortScript,
    pacing: super::serial::WriterPacing,
) -> (
    super::serial::SerialLedPacketSender,
    Arc<Mutex<Vec<Arc<PortLog>>>>,
) {
    let logs: Arc<Mutex<Vec<Arc<PortLog>>>> = Arc::default();
    let logs_for_factory = Arc::clone(&logs);
    let sender = super::serial::SerialLedPacketSender::with_pacing_for_tests(
        move |_port_name| {
            let log = Arc::new(PortLog::default());
            logs_for_factory
                .lock()
                .expect("logs lock")
                .push(Arc::clone(&log));
            Ok(Box::new(ScriptedPort { log, script }) as Box<dyn Write + Send>)
        },
        pacing,
    );
    (sender, logs)
}

fn first_log(logs: &Mutex<Vec<Arc<PortLog>>>) -> Arc<PortLog> {
    Arc::clone(&logs.lock().expect("logs lock")[0])
}

fn no_pacing(_: usize) -> Duration {
    Duration::ZERO
}

fn pacing_100ms(_: usize) -> Duration {
    Duration::from_millis(100)
}

fn pacing_1s(_: usize) -> Duration {
    Duration::from_secs(1)
}

fn pacing_10s(_: usize) -> Duration {
    Duration::from_secs(10)
}

#[test]
fn a_slow_link_never_blocks_the_sender() {
    // 150 ms per write is a link far slower than any frame interval. The
    // worker used to wait out every write and then a flush on top.
    let script = PortScript {
        write_takes: Duration::from_millis(150),
        ..PortScript::default()
    };
    let (sender, logs) = scripted_sender(script, no_pacing);

    sender
        .send("COM1", &[1])
        .expect("first send opens the port");
    for byte in 2..6_u8 {
        let started = Instant::now();
        sender.send("COM1", &[byte]).expect("send");
        assert!(
            started.elapsed() < Duration::from_millis(50),
            "send {byte} waited {:?} on the port",
            started.elapsed()
        );
    }
    sender.wait_idle("COM1");
    assert_eq!(
        first_log(&logs).packets().last(),
        Some(&vec![5]),
        "the newest packet is the one that ends up on the wire"
    );
}

#[test]
fn packets_queued_while_the_link_is_busy_collapse_to_the_newest() {
    // A second of wire time, so a stalled CI runner cannot let packet 2 out
    // on its own between the sends below.
    let (sender, logs) = scripted_sender(PortScript::default(), pacing_1s);

    sender.send("COM1", &[1]).expect("send");
    // Wait for the writer to take packet 1, so 2..=5 all land inside its wire time.
    let deadline = Instant::now() + Duration::from_secs(5);
    while first_log(&logs).packets().is_empty() {
        assert!(Instant::now() < deadline, "packet 1 never reached the port");
        std::thread::sleep(Duration::from_millis(1));
    }
    for byte in 2..=5_u8 {
        sender.send("COM1", &[byte]).expect("send");
    }
    sender.wait_idle("COM1");

    assert_eq!(first_log(&logs).packets(), vec![vec![1], vec![5]]);
}

#[test]
fn the_next_packet_waits_out_the_previous_one_on_the_wire() {
    let (sender, logs) = scripted_sender(PortScript::default(), pacing_100ms);

    sender.send("COM1", &[1]).expect("send");
    sender.wait_idle("COM1");
    sender.send("COM1", &[2]).expect("send");
    sender.wait_idle("COM1");

    let times = first_log(&logs).write_times();
    assert_eq!(times.len(), 2);
    assert!(
        times[1].duration_since(times[0]) >= Duration::from_millis(100),
        "packet 2 started {:?} after packet 1, inside its wire time",
        times[1].duration_since(times[0])
    );
}

#[test]
fn link_pacing_is_the_wire_time_plus_its_margin() {
    // 498 bytes is a 164-LED RGB frame: 43.23 ms at 11 520 bytes/s.
    let paced = super::serial::link_pacing(498);
    assert!(
        paced > Duration::from_micros(44_000) && paced < Duration::from_micros(44_200),
        "got {paced:?}"
    );
    assert!(super::serial::link_pacing(498) > crate::commands::led_calibration::wire_duration(498));
}

#[test]
fn streaming_never_drains_the_port() {
    let (sender, logs) = scripted_sender(PortScript::default(), no_pacing);
    for byte in 0..5_u8 {
        sender.send("COM1", &[byte]).expect("send");
        sender.wait_idle("COM1");
    }
    assert_eq!(first_log(&logs).flushes.load(Ordering::SeqCst), 0);
}

#[test]
fn a_failed_write_reaches_the_next_send_and_the_one_after_reopens() {
    let script = PortScript {
        fail_writes: true,
        ..PortScript::default()
    };
    let (sender, logs) = scripted_sender(script, no_pacing);

    sender
        .send("COM1", &[1])
        .expect("the write has not happened yet");
    sender.wait_idle("COM1");
    let error = sender.send("COM1", &[2]).expect_err("the failure surfaces");
    assert_eq!(error.code, "LED_OUTPUT_WRITE_FAILED");

    sender.send("COM1", &[3]).expect("a fresh session");
    assert_eq!(
        logs.lock().unwrap().len(),
        2,
        "the dead handle was reopened"
    );
    assert!(first_log(&logs).dropped.load(Ordering::SeqCst));
}

#[test]
fn send_and_wait_reports_its_own_outcome() {
    let (sender, logs) = scripted_sender(PortScript::default(), pacing_100ms);
    sender
        .send_and_wait("COM1", &[7])
        .expect("written and drained");
    let log = first_log(&logs);
    assert_eq!(log.packets(), vec![vec![7]]);
    assert_eq!(log.flushes.load(Ordering::SeqCst), 1);

    let failing = PortScript {
        fail_writes: true,
        ..PortScript::default()
    };
    let (sender, _) = scripted_sender(failing, no_pacing);
    let error = sender.send_and_wait("COM1", &[7]).expect_err("write fails");
    assert_eq!(error.code, "LED_OUTPUT_WRITE_FAILED");

    let failing_drain = PortScript {
        fail_flushes: true,
        ..PortScript::default()
    };
    let (sender, logs) = scripted_sender(failing_drain, no_pacing);
    let error = sender.send_and_wait("COM1", &[7]).expect_err("drain fails");
    assert_eq!(error.code, "LED_OUTPUT_FLUSH_FAILED");
    sender
        .send("COM1", &[8])
        .expect("the failed session was removed");
    assert_eq!(logs.lock().unwrap().len(), 2);
}

#[test]
fn disconnect_interrupts_a_pacing_wait_and_closes_the_port() {
    let (sender, logs) = scripted_sender(PortScript::default(), pacing_10s);
    sender.send("COM1", &[1]).expect("send");
    sender.wait_idle("COM1");
    sender
        .send("COM1", &[2])
        .expect("queued behind a 10 s wire time");

    let started = Instant::now();
    sender.disconnect_session("COM1");
    assert!(
        started.elapsed() < Duration::from_millis(200),
        "disconnect took {:?}",
        started.elapsed()
    );
    let log = first_log(&logs);
    assert!(
        log.dropped.load(Ordering::SeqCst),
        "the port is closed on return"
    );
    assert_eq!(
        log.packets(),
        vec![vec![1]],
        "nothing is written after close"
    );
}

#[test]
fn a_wedged_write_is_detached_instead_of_stalling_disconnect() {
    let script = PortScript {
        write_takes: Duration::from_secs(3),
        ..PortScript::default()
    };
    let (sender, logs) = scripted_sender(script, no_pacing);
    sender.send("COM1", &[1]).expect("send");
    let deadline = Instant::now() + Duration::from_secs(5);
    while first_log(&logs).writes_started.load(Ordering::SeqCst) == 0 {
        assert!(
            Instant::now() < deadline,
            "the writer never started packet 1"
        );
        std::thread::sleep(Duration::from_millis(1));
    }

    let started = Instant::now();
    sender.disconnect_session("COM1");
    let took = started.elapsed();
    assert!(
        took >= super::serial::WRITER_EXIT_TIMEOUT && took < Duration::from_millis(1_500),
        "disconnect took {took:?}"
    );
}

#[test]
fn bridge_disconnect_session_delegates_to_sender() {
    let sender = Arc::new(FakeSender::successful());
    let bridge = LedOutputBridge::from_sender(sender.clone());

    bridge.disconnect_session("COM5");

    assert_eq!(sender.disconnected_ports(), vec!["COM5".to_string()]);
}
