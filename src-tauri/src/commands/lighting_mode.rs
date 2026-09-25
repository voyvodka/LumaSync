//! Lighting mode state machine — owns the Off/Solid/Ambilight transitions,
//! the ambilight capture→sample→correct→send worker thread, and the LED
//! test-pattern preview path that reuses the same worker plumbing.
//!
//! This file is the façade: the code lives in the submodules below, split by
//! what it does, and the paths the rest of the crate uses are re-exported here.
//!
//! - `config`, `config_check`, `hydrate` — the request, its validation, and the
//!   persisted-state fallbacks
//! - `transition` — `apply_mode_change` and the mode commands
//! - `runtime`, `live` — the managed state and the settings a worker re-reads
//! - `worker`, `frame_pipeline`, `sampling`, `smoothing`, `pacing`, `usb_output`
//!   — the ambilight worker and what it drives
//! - `preview`, `led_test_pattern` — the twin feed and the LED test pattern
//! - `outputs`, `snapshot`, `tuning`, `hue_driver` — the lighting transaction

use std::sync::atomic::AtomicUsize;

mod config;
pub(crate) mod config_check;
mod frame_pipeline;
pub mod hue_driver;
mod hydrate;
pub mod led_test_pattern;
mod live;
pub mod outputs;
mod pacing;
pub mod preview;
mod runtime;
mod sampling;
pub(crate) mod smoothing;
pub mod snapshot;
pub mod transition;
pub mod tuning;
mod usb_output;
mod worker;

pub use config::{
    AmbilightPayload, LightingModeCommandResult, LightingModeConfig, LightingModeKind,
    SolidColorPayload,
};
pub use led_test_pattern::{start_led_test_pattern, stop_led_test_pattern};
pub use preview::get_led_preview_status;
pub use runtime::LightingRuntimeState;
pub use transition::stop_lighting_blocking;

#[cfg(test)]
pub(crate) use led_test_pattern::LedTestPatternResult;
#[cfg(test)]
pub(crate) use sampling::SYNTHETIC_SAMPLE_WINDOW;
#[cfg(test)]
pub(crate) use transition::{set_lighting_mode, stop_lighting, AppliedModeProbe};

static ACTIVE_AMBILIGHT_WORKERS: AtomicUsize = AtomicUsize::new(0);
static SOLID_OUTPUT_ATTEMPTS: AtomicUsize = AtomicUsize::new(0);
static AMBILIGHT_FRAME_ATTEMPTS: AtomicUsize = AtomicUsize::new(0);
static AMBILIGHT_CAPTURE_ATTEMPTS: AtomicUsize = AtomicUsize::new(0);

// Test-only serial guard. `start_ambilight_worker` mutates the process-global
// `ACTIVE_AMBILIGHT_WORKERS` counter, and several tests across BOTH test
// modules below either spawn real worker threads or assert exact counter
// values. Under `cargo test`'s default thread-level parallelism those tests
// race on the shared counter (one test spawns a worker -> count==1 while
// another asserts count==0). This mutex serialises every worker-touching test
// so the global counter is guaranteed to start at 0 for each one. It lives at
// the parent-module scope so both `transition_tests` and `lighting_mode_tests`
// share the SAME lock. `Mutex::new(())` is a const fn, so no lazy
// initialisation is needed. Test-execution ordering only -- zero production
// impact.
#[cfg(test)]
static WORKER_TEST_GUARD: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(test)]
mod frame_pipeline_tests;

#[cfg(test)]
mod callers_tests;

#[cfg(test)]
mod outputs_tests;

#[cfg(test)]
mod transition_tests;

#[cfg(test)]
mod lighting_mode_tests;

#[cfg(test)]
mod config_tests;

#[cfg(test)]
mod live_tests;

#[cfg(test)]
mod pacing_tests;

#[cfg(test)]
mod preview_tests;

#[cfg(test)]
mod led_test_pattern_tests;

#[cfg(test)]
mod test_support;
#[cfg(test)]
pub(crate) use test_support::{calibration as calibration_for_tests, EventLog, FakeHue, Watchdog};
