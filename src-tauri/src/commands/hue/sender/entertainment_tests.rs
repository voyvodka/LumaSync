//! The shutdown-signal primitive and the deactivate dedupe token: both
//! testable without a bridge.

use std::sync::Arc;
use std::thread;
use std::time::Duration;

use super::entertainment::{
    new_shutdown_signal, settle_deactivate, signal_shutdown_complete, wait_for_shutdown,
    DeactivateToken,
};

#[test]
fn shutdown_signal_fires_when_sender_thread_exits() {
    let signal = new_shutdown_signal();
    let signal_clone = Arc::clone(&signal);

    thread::spawn(move || {
        thread::sleep(Duration::from_millis(50));
        signal_shutdown_complete(&signal_clone);
    });

    let completed = wait_for_shutdown(&signal, Duration::from_secs(2));
    assert!(completed, "shutdown signal should have fired within 2s");
}

#[test]
fn shutdown_signal_times_out_when_thread_does_not_signal() {
    let signal = new_shutdown_signal();
    let completed = wait_for_shutdown(&signal, Duration::from_millis(100));
    assert!(!completed, "should have timed out");
}

// -----------------------------------------------------------------------
// DeactivateToken — dedupe primitive for entertainment-config
// deactivation across the sender thread, foreground stop, and reconnect monitor.
// -----------------------------------------------------------------------

#[test]
fn a_failed_put_hands_the_token_back_so_a_later_caller_retries() {
    let token = DeactivateToken::new();
    assert!(token.try_acquire(), "first caller wins");

    let outcome = settle_deactivate(&token, "area-1", Err("bridge unreachable".to_string()));

    assert!(outcome.is_err(), "the failure still reaches the caller");
    assert!(
        !token.was_acquired(),
        "a burned token after a failed PUT means nothing ever deactivates the area"
    );
    assert!(token.try_acquire(), "the next caller can retry");
}

#[test]
fn a_successful_put_keeps_the_token_burned() {
    let token = DeactivateToken::new();
    assert!(token.try_acquire(), "first caller wins");

    let outcome = settle_deactivate(&token, "area-1", Ok(()));

    assert!(outcome.is_ok());
    // Releasing here would reopen the concurrent-duplicate-PUT race the
    // token exists to close (the phantom active streamer).
    assert!(token.was_acquired());
    assert!(!token.try_acquire(), "later callers still no-op");
}

#[test]
fn deactivate_token_grants_first_caller_only_once() {
    let token = DeactivateToken::new();
    assert!(
        token.try_acquire(),
        "first caller should win the deactivate token"
    );
    assert!(
        !token.try_acquire(),
        "second caller must observe the in-flight bit and no-op"
    );
    assert!(
        token.was_acquired(),
        "was_acquired must reflect that a winner exists"
    );
}

#[test]
fn deactivate_token_dedupes_concurrent_callers() {
    // Spawn many threads that race for the token; exactly one wins.
    let token = DeactivateToken::new();
    let mut handles = Vec::new();
    let winners = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    for _ in 0..16 {
        let t = Arc::clone(&token);
        let w = Arc::clone(&winners);
        handles.push(thread::spawn(move || {
            if t.try_acquire() {
                w.fetch_add(1, std::sync::atomic::Ordering::AcqRel);
            }
        }));
    }
    for h in handles {
        h.join().expect("worker did not panic");
    }
    assert_eq!(
        winners.load(std::sync::atomic::Ordering::Acquire),
        1,
        "exactly one caller must win the token even under concurrent pressure"
    );
    assert!(token.was_acquired());
}
