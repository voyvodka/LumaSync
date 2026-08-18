//! Debug-only CI bench hooks. Each one answers a question that needs a real
//! machine — an OS keychain that is not macOS, a compositor that is not this
//! one — and the CI runners are the only such machines the project has. They
//! are `cfg(debug_assertions)`, off unless their environment variable is set to
//! `1`, and report through the log, so `scripts/verify/launch-smoke.mjs`
//! carries them with `--expect`. See docs/architecture/build-and-release.md,
//! "The CI platform bench".

use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::commands::ambilight_capture::{
    create_live_frame_source, detect_black_borders, AmbilightFrameSource, CapturedFrame,
    BLACK_BORDER_THRESHOLD,
};
use crate::commands::hue::credential_store::{default_store, SecretStore};

/// Account used by the credential round-trip. Deliberately unlike any real
/// account name (`hue-app-key`, `hue-client-key`) so a bug in this file can
/// never overwrite a credential someone depends on.
const ROUNDTRIP_ACCOUNT: &str = "__lumasync_smoke_roundtrip__";

/// The window is up by the time `setup` returns, but the first frames of a
/// compositor session are the least representative ones — and on macOS the
/// TCC prompt, if it is going to appear, wants the app settled first.
const CAPTURE_SETTLE: Duration = Duration::from_secs(3);

/// How long the probe waits for the stream's first callback, and how often it
/// asks — see `first_frame`. Well inside the driver's 30 s expectation budget.
const FIRST_FRAME_WAIT: Duration = Duration::from_secs(5);
const FIRST_FRAME_POLL: Duration = Duration::from_millis(100);

/// `1` arms a hook; anything else leaves it off. Not presence-based: CI passes
/// these through `env:` blocks where an empty string is easy to produce by
/// accident, and an accidental capture probe costs a screen-recording prompt.
///
/// Takes the lookup rather than the variable name so each literal stays inside
/// an `env::var(...)` call. `verify:shell-contracts` harvests bare
/// `"SCREAMING_SNAKE"` literals as status codes and strips that one call shape;
/// passing the name here would report both variables as undeclared producers,
/// silenceable only by adding non-codes to a contract ratchet.
fn armed(lookup: Result<String, std::env::VarError>) -> bool {
    match lookup {
        Ok(value) if value == "1" => true,
        Ok(value) if value.is_empty() || value == "0" => false,
        Ok(value) => {
            log::warn!("[smoke] a hook variable is set to {value:?}, not \"1\" — it stays off");
            false
        }
        Err(_) => false,
    }
}

fn nonce() -> String {
    let micros = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_micros())
        .unwrap_or(0);
    format!("{}-{micros}", std::process::id())
}

// ---------------------------------------------------------------------------
// A. Credential round-trip — backlog #233 / #212
// ---------------------------------------------------------------------------

/// Exercise the process credential store end to end: set, read back, compare,
/// delete, confirm gone. No-op unless `LUMASYNC_SMOKE_CREDENTIALS=1`.
///
/// A debug build seeds `DevFileStore` in `setup`, so this proves the *OS*
/// keychain only when `LUMASYNC_DEV_USE_KEYCHAIN=1` was set too — which is why
/// the log line names the backend it actually got rather than assuming one.
pub fn spawn_credential_roundtrip() {
    if !armed(std::env::var("LUMASYNC_SMOKE_CREDENTIALS")) {
        return;
    }

    // Off the setup thread: Secret Service and Credential Manager are both
    // blocking D-Bus/RPC calls, and one slow keyring must not delay startup.
    let spawned = std::thread::Builder::new()
        .name("smoke-cred".into())
        .spawn(credential_roundtrip);
    if let Err(error) = spawned {
        log::error!("[smoke-cred] FAIL step=spawn backend=unknown detail={error}");
    }
}

fn credential_roundtrip() {
    let store = default_store();
    let backend = store.backend().as_str();
    let expected = format!("roundtrip-{}", nonce());

    let outcome = run_roundtrip(store.as_ref(), &expected);

    // Unconditional: a leaked entry outlives the process, and on Windows it
    // would be a visible item in the user's Credential Manager.
    if let Err(error) = store.delete(ROUNDTRIP_ACCOUNT) {
        log::warn!("[smoke-cred] cleanup delete failed backend={backend}: {error}");
    }

    match outcome {
        Ok(timing) => log::info!(
            "[smoke-cred] backend={backend} roundtrip=ok set={} get={} delete={}",
            timing.set_ms,
            timing.get_ms,
            timing.delete_ms
        ),
        Err(failure) => log::error!(
            "[smoke-cred] FAIL step={} backend={backend} detail={}",
            failure.step,
            failure.detail
        ),
    }
}

struct RoundtripTiming {
    set_ms: u128,
    get_ms: u128,
    delete_ms: u128,
}

struct RoundtripFailure {
    step: &'static str,
    detail: String,
}

fn fail(step: &'static str, detail: impl Into<String>) -> RoundtripFailure {
    RoundtripFailure {
        step,
        detail: detail.into(),
    }
}

fn run_roundtrip(
    store: &dyn SecretStore,
    expected: &str,
) -> Result<RoundtripTiming, RoundtripFailure> {
    let started = Instant::now();
    store
        .set(ROUNDTRIP_ACCOUNT, expected)
        .map_err(|error| fail("set", error))?;
    let set_ms = started.elapsed().as_millis();

    let started = Instant::now();
    let read_back = store
        .get(ROUNDTRIP_ACCOUNT)
        .map_err(|error| fail("get", error))?;
    let get_ms = started.elapsed().as_millis();

    // Never log either value: this one is a nonce, but the shape of the line
    // is what the next person copies for a real account.
    match read_back {
        Some(value) if value == expected => {}
        Some(value) => {
            return Err(fail(
                "verify",
                format!(
                    "read-back differs: wrote {} bytes, read {} bytes",
                    expected.len(),
                    value.len()
                ),
            ))
        }
        None => {
            return Err(fail(
                "verify",
                "read-back missing: the entry was not stored",
            ))
        }
    }

    let started = Instant::now();
    store
        .delete(ROUNDTRIP_ACCOUNT)
        .map_err(|error| fail("delete", error))?;
    let delete_ms = started.elapsed().as_millis();

    match store.get(ROUNDTRIP_ACCOUNT) {
        Ok(None) => {}
        Ok(Some(_)) => {
            return Err(fail(
                "verify-gone",
                "the entry survived its own delete — the backend is not writing through",
            ))
        }
        Err(error) => return Err(fail("verify-gone", error)),
    }

    Ok(RoundtripTiming {
        set_ms,
        get_ms,
        delete_ms,
    })
}

// ---------------------------------------------------------------------------
// B. Single-frame capture probe — backlog #234
// ---------------------------------------------------------------------------

/// Capture exactly one frame through the ordinary live path and report its
/// shape. No-op unless `LUMASYNC_SMOKE_CAPTURE=1`.
///
/// This is what a runner can prove that a maintainer's machine cannot: that
/// the Windows WGC and Linux xcap branches return a frame of the size the
/// downscale policy says they should, in the pixel order the sampler assumes.
pub fn spawn_capture_probe() {
    if !armed(std::env::var("LUMASYNC_SMOKE_CAPTURE")) {
        return;
    }

    let spawned = std::thread::Builder::new()
        .name("smoke-capture".into())
        .spawn(|| {
            std::thread::sleep(CAPTURE_SETTLE);
            capture_probe();
        });
    if let Err(error) = spawned {
        log::error!("[smoke-capture] FAIL code=PROBE_THREAD_SPAWN_FAILED detail={error}");
    }
}

/// Runs on the probe's own thread, never the main one. The macOS branch holds
/// an `SCStream`, and dropping one from the main thread deadlocks against the
/// stream's own dispatch queue — the same rule `LightingWorkerRuntime::stop`
/// follows. Everything below, including the drop of `source`, stays here.
fn capture_probe() {
    let started = Instant::now();

    let mut source = match create_live_frame_source(None) {
        Ok(source) => source,
        Err(error) => return report_capture_error(&error.as_reason()),
    };

    let frame = match first_frame(source.as_mut()) {
        Ok(frame) => frame,
        Err(reason) => {
            drop(source);
            return report_capture_error(&reason);
        }
    };
    let ms = started.elapsed().as_millis();

    let pixels = frame.pixels_rgb.len();
    if pixels == 0 {
        drop(frame);
        drop(source);
        // An existing declared reason, not a new one minted for the probe: a
        // frame with no pixels is exactly what that code already means.
        return report_capture_error("AMBILIGHT_CAPTURE_PIXEL_BUFFER_INVALID");
    }

    let mut sums = [0u64; 3];
    for pixel in &frame.pixels_rgb {
        sums[0] += u64::from(pixel[0]);
        sums[1] += u64::from(pixel[1]);
        sums[2] += u64::from(pixel[2]);
    }
    let total = pixels as u64;
    let avg = [sums[0] / total, sums[1] / total, sums[2] / total];

    let borders = detect_black_borders(&frame, BLACK_BORDER_THRESHOLD);

    log::info!(
        "[smoke-capture] frame={}x{} pixels={} avg={},{},{} borders={:.4},{:.4},{:.4},{:.4} ms={}",
        frame.width,
        frame.height,
        pixels,
        avg[0],
        avg[1],
        avg[2],
        borders.top,
        borders.right,
        borders.bottom,
        borders.left,
        ms
    );

    drop(frame);
    drop(source);
}

/// Poll until the stream delivers, because "capture one frame" is not a single
/// call on two of the three platforms. macOS SCStream and Windows WGC both push
/// into a shared slot from their own callback, so the first `capture_frame()`
/// after construction reliably races it and answers `FRAME_UNAVAILABLE` — which
/// the live worker simply polls past, and a probe that reported it would be
/// reporting its own timing rather than the platform's. Linux xcap pulls, so it
/// answers on the first try. Anything other than "not yet" is terminal:
/// a denied permission does not become granted by asking again.
fn first_frame(
    source: &mut dyn AmbilightFrameSource,
) -> Result<std::sync::Arc<CapturedFrame>, String> {
    let deadline = Instant::now() + FIRST_FRAME_WAIT;
    loop {
        match source.capture_frame() {
            Ok(frame) => return Ok(frame),
            Err(error) => {
                let reason = error.as_reason();
                if reason != "AMBILIGHT_CAPTURE_FRAME_UNAVAILABLE" || Instant::now() >= deadline {
                    return Err(reason);
                }
            }
        }
        std::thread::sleep(FIRST_FRAME_POLL);
    }
}

/// A denied screen-recording consent is a fact about the machine, not a defect
/// in the code, so it is reported as SKIP — the CI runner that cannot grant it
/// must not turn red for saying so.
fn report_capture_error(code: &str) {
    if code == "AMBILIGHT_CAPTURE_PERMISSION_DENIED" {
        log::warn!("[smoke-capture] SKIP code={code}");
    } else {
        log::error!("[smoke-capture] FAIL code={code}");
    }
}
