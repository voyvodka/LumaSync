//! Milliseconds from `run()` to each launch step, in the log, so a slow launch
//! is read rather than guessed. The frontend marks its own steps against the
//! same clock (`src/shared/lib/startupTiming.ts`): the epoch logged here.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

static STARTED: OnceLock<(Instant, u128)> = OnceLock::new();
static PAGE_LOADED: AtomicBool = AtomicBool::new(false);

/// First thing in `run()`: before the logger exists, so nothing is logged yet.
pub fn begin() {
    let epoch_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_millis());
    let _ = STARTED.set((Instant::now(), epoch_ms));
}

pub fn mark(step: &str) {
    if let Some((started, epoch_ms)) = STARTED.get() {
        log::info!(
            "[startup] {step} +{}ms (run() at epoch {epoch_ms})",
            started.elapsed().as_millis()
        );
    }
}

/// The main window's page finished loading; later loads are reloads.
pub fn mark_page_loaded() {
    if !PAGE_LOADED.swap(true, Ordering::SeqCst) {
        mark("main page loaded");
    }
}
