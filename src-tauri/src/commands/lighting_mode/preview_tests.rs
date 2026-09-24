//! Whether a worker builds the twin feed at all.

use std::sync::Arc;

/// Only twin overlays read the enriched buffer, so a running test with no
/// twin open must not build an N-LED Vec + JSON payload every tick.
#[test]
fn test_source_enrichment_follows_the_twin_gate() {
    let gate = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let ctx = super::preview::build_preview_emit_context(
        true,
        None,
        Some(Arc::clone(&gate)),
        Some("display-1".to_string()),
    )
    .expect("a test always yields an emit context");

    assert_eq!(ctx.source, "test");
    // Synthetic frames are display-agnostic — never filtered per display.
    assert_eq!(ctx.display_id, None);
    assert!(!ctx.should_enrich(), "no twin open ⇒ no enrichment");

    gate.store(true, std::sync::atomic::Ordering::Relaxed);
    assert!(ctx.should_enrich(), "twin opened mid-run ⇒ enrichment on");
}

/// With no gate wired (unit-test / legacy path) a test still enriches, so
/// the twin is never left dark by a missing registration.
#[test]
fn test_source_enriches_unconditionally_without_a_gate() {
    let ctx = super::preview::build_preview_emit_context(true, None, None, None)
        .expect("a test always yields an emit context");
    assert!(ctx.should_enrich());
}
