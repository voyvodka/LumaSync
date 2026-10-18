//! Whether a worker builds the twin feed at all.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// Only a subscribed twin reads the frame, so a worker with none must not
/// build an N-LED buffer every tick; one subscribing mid-run turns it on.
#[test]
fn the_twin_feed_follows_the_session_gate() {
    let gate = Arc::new(AtomicBool::new(false));
    let ctx = super::preview::build_preview_emit_context(Some(Arc::clone(&gate)))
        .expect("a wired gate yields a context");
    assert!(!ctx.should_enrich(), "no twin subscribed ⇒ no frame");
    gate.store(true, Ordering::Relaxed);
    assert!(ctx.should_enrich(), "a twin subscribed mid-run ⇒ frames");
}

#[test]
fn no_gate_builds_nothing() {
    assert!(super::preview::build_preview_emit_context(None).is_none());
}
