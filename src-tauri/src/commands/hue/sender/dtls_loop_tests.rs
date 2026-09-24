//! The DTLS send loop: newest-frame-on-hand, the send floor, and telling a
//! write failure that is just the stop in progress apart from a real fault.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering as AtomicOrdering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use super::super::frame::{build_huestream_frame, HueColorSender};
use super::dtls_loop::{dtls_write_failed_during_stop, DtlsSendLoop, HUE_SENDER_MIN_INTERVAL_MS};
use super::entertainment::DeactivateToken;
use super::test_support::bridge_channel;

struct RecordingSocket(Arc<Mutex<Vec<Vec<u8>>>>);

impl std::io::Write for RecordingSocket {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().push(buf.to_vec());
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// Item 16: the loop took a frame, slept out the send floor, then sent the
/// frame it took — up to one interval stale. Frames that arrive during the
/// sleep are newer, and the newest is the one that must go out. The floor
/// is widened here only so the frames land inside the sleep on any runner.
#[test]
fn the_dtls_loop_sends_the_newest_frame_on_hand_at_send_time() {
    let channels = vec![bridge_channel(0)];
    let metadata = HashMap::new();
    let counter = AtomicU32::new(0);
    let token = DeactivateToken::new();
    let written: Arc<Mutex<Vec<Vec<u8>>>> = Arc::default();
    let frames_written = || written.lock().unwrap().len();
    let wait_for_frames = |n: usize| {
        let deadline = Instant::now() + Duration::from_secs(10);
        while frames_written() < n {
            assert!(Instant::now() < deadline, "frame {n} was never written");
            thread::sleep(Duration::from_millis(5));
        }
    };
    let expected =
        |red: u8| build_huestream_frame("area", &channels, &[(red, 0, 0)], 1.0, &metadata);
    let (sender, rx) = HueColorSender::with_mailbox(1);

    thread::scope(|scope| {
        let socket = Arc::clone(&written);
        let (channels, metadata, counter, token, rx) =
            (&channels, &metadata, &counter, &token, &rx);
        scope.spawn(move || {
            DtlsSendLoop {
                area_id: "area",
                channels,
                light_metadata: metadata,
                packet_counter: counter,
                deactivate_token: token,
                min_interval: Duration::from_secs(1),
                keepalive: Duration::from_secs(60),
            }
            .run(&mut RecordingSocket(socket), rx);
        });

        sender.try_send(1, 0, 0, 1.0);
        wait_for_frames(1);
        // Wakes the loop, which then sleeps out the rest of the interval.
        sender.try_send(2, 0, 0, 1.0);
        thread::sleep(Duration::from_millis(50));
        sender.try_send(3, 0, 0, 1.0);
        sender.try_send(4, 0, 0, 1.0);
        wait_for_frames(2);
        drop(sender);
    });

    let written = written.lock().unwrap();
    assert_eq!(written.len(), 2);
    assert_eq!(written[0], expected(1));
    assert_eq!(
        written[1],
        expected(4),
        "a frame older than the newest went out"
    );
    assert_eq!(counter.load(AtomicOrdering::Relaxed), 2);
}

/// The loop must not send faster than the floor however fast frames come.
#[test]
fn the_dtls_loop_holds_the_send_floor() {
    let channels = vec![bridge_channel(0)];
    let metadata = HashMap::new();
    let counter = AtomicU32::new(0);
    let token = DeactivateToken::new();
    let written: Arc<Mutex<Vec<Vec<u8>>>> = Arc::default();
    let (sender, rx) = HueColorSender::with_mailbox(1);
    let min_interval = Duration::from_millis(HUE_SENDER_MIN_INTERVAL_MS);
    let started = Instant::now();

    thread::scope(|scope| {
        let socket = Arc::clone(&written);
        let (channels, metadata, counter, token, rx) =
            (&channels, &metadata, &counter, &token, &rx);
        scope.spawn(move || {
            DtlsSendLoop {
                area_id: "area",
                channels,
                light_metadata: metadata,
                packet_counter: counter,
                deactivate_token: token,
                min_interval,
                keepalive: Duration::from_secs(60),
            }
            .run(&mut RecordingSocket(socket), rx);
        });
        let mut tick = 0u8;
        while started.elapsed() < Duration::from_millis(500) {
            tick = tick.wrapping_add(1);
            sender.try_send(tick, 0, 0, 1.0);
            thread::sleep(Duration::from_millis(2));
        }
        drop(sender);
    });

    let sent = counter.load(AtomicOrdering::Relaxed) as u128;
    let ceiling = started.elapsed().as_millis() / min_interval.as_millis() + 1;
    assert!(sent >= 2, "only {sent} frames went out");
    assert!(sent <= ceiling, "{sent} frames in {:?}", started.elapsed());
}

/// A write failing under a live session is a fault and must stay ERROR.
#[test]
fn a_write_failure_on_a_live_session_is_not_a_stop() {
    let token = DeactivateToken::new();
    let (_tx, rx) = HueColorSender::with_mailbox(1);
    assert!(!dtls_write_failed_during_stop(&token, &rx));
}

/// The Off race: the foreground stop won the token and its PUT ended the
/// bridge session while a frame was in flight.
#[test]
fn a_write_failure_after_the_stop_took_the_token_is_the_stop() {
    let token = DeactivateToken::new();
    let (_tx, rx) = HueColorSender::with_mailbox(1);
    assert!(token.try_acquire());
    assert!(dtls_write_failed_during_stop(&token, &rx));
}

#[test]
fn a_write_failure_after_every_sender_handle_dropped_is_the_stop() {
    let token = DeactivateToken::new();
    let (tx, rx) = HueColorSender::with_mailbox(1);
    drop(tx);
    assert!(dtls_write_failed_during_stop(&token, &rx));
}
