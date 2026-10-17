/// Longest capture edge after downscale, shared by all three capture paths —
/// a per-path duplicate drifts silently. The `cfg` still names the platforms
/// that downscale, so an unsupported-platform build does not carry it.
/// See docs/architecture/capture-and-pipeline.md.
#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
const MAX_CAPTURE_DIM: u32 = 640;

/// Nearest-neighbour subsample step that brings the longest edge under
/// [`MAX_CAPTURE_DIM`]. Clamps to 1, so a display already under the cap is
/// copied through unchanged.
///
/// Windows and Linux both receive a whole native frame and must reduce it
/// CPU-side; macOS asks ScreenCaptureKit for the smaller frame instead and
/// never calls this.
#[cfg(any(target_os = "windows", target_os = "linux", test))]
fn downscale_stride(width: u32, height: u32) -> usize {
    (width.max(height) / MAX_CAPTURE_DIM).max(1) as usize
}

/// Dimensions a `width`×`height` frame collapses to under `stride`.
#[cfg(any(target_os = "windows", target_os = "linux", test))]
fn downscaled_dimensions(width: u32, height: u32, stride: usize) -> (u32, u32) {
    (
        (width as usize).div_ceil(stride) as u32,
        (height as usize).div_ceil(stride) as u32,
    )
}

/// Drop the fourth byte of every source pixel, keeping every `stride`-th
/// pixel on both axes.
///
/// `src` must be exactly `width * height * 4` bytes; callers slice it to that
/// length after their own buffer-length guard, which is what makes the
/// indexing below total.
///
/// Channel-agnostic on purpose. `windows-capture` delivers BGRA and `xcap`
/// delivers RGBA, and both paths have always taken bytes 0..3 in source
/// order — this keeps that behaviour rather than quietly changing it.
#[cfg(any(target_os = "windows", target_os = "linux", test))]
fn subsample_rgb(src: &[u8], width: usize, height: usize, stride: usize) -> Vec<[u8; 3]> {
    debug_assert_eq!(src.len(), width.saturating_mul(height).saturating_mul(4));

    let (dst_w, dst_h) = downscaled_dimensions(width as u32, height as u32, stride);
    let mut pixels_rgb = Vec::with_capacity((dst_w as usize).saturating_mul(dst_h as usize));

    // Stride 1 keeps the original tight loop; the strided walk skips rows and
    // columns so a 3840×2160 frame collapses to ~640×360 on the host CPU.
    if stride == 1 {
        for pixel in src.as_chunks::<4>().0 {
            pixels_rgb.push([pixel[0], pixel[1], pixel[2]]);
        }
    } else {
        let row_bytes = width.saturating_mul(4);
        for y in (0..height).step_by(stride) {
            let row_start = y.saturating_mul(row_bytes);
            for x in (0..width).step_by(stride) {
                let offset = row_start + x.saturating_mul(4);
                pixels_rgb.push([src[offset], src[offset + 1], src[offset + 2]]);
            }
        }
    }

    pixels_rgb
}

static NEXT_FRAME_SEQ: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CapturedFrame {
    pub width: u32,
    pub height: u32,
    pub pixels_rgb: Vec<[u8; 3]>,
    /// Unique per captured frame and kept by a clone, so a source handing out
    /// the same frame twice is recognisable. Never 0.
    pub seq: u64,
    pub captured_at: Instant,
}

impl CapturedFrame {
    pub fn new(width: u32, height: u32, pixels_rgb: Vec<[u8; 3]>) -> Self {
        Self {
            width,
            height,
            pixels_rgb,
            seq: NEXT_FRAME_SEQ.fetch_add(1, Ordering::Relaxed),
            captured_at: Instant::now(),
        }
    }

    /// The same pixels as a new frame: a fresh `seq` and capture time, for a
    /// source that reuses its buffer instead of allocating one per frame.
    pub(crate) fn restamp(&mut self) {
        self.seq = NEXT_FRAME_SEQ.fetch_add(1, Ordering::Relaxed);
        self.captured_at = Instant::now();
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AmbilightCaptureError {
    /// Surfaced when a platform's capture pipeline reports a missing frame
    /// (e.g. macOS SCDisplay drop, Windows DXGI desktop switch). Linux's
    /// xcap branch currently constructs only `InvalidFrame`, so the
    /// variant is forward-looking there — keep allow(dead_code)
    /// unconditional rather than a per-platform cfg matrix that drifts
    /// every time a backend lands.
    #[allow(dead_code)]
    FrameUnavailable,
    InvalidFrame(&'static str),
}

impl AmbilightCaptureError {
    pub fn as_reason(&self) -> String {
        match self {
            Self::FrameUnavailable => "AMBILIGHT_CAPTURE_FRAME_UNAVAILABLE".to_string(),
            Self::InvalidFrame(code) => code.to_string(),
        }
    }
}

use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

pub trait AmbilightFrameSource: Send {
    fn capture_frame(&mut self) -> Result<Arc<CapturedFrame>, AmbilightCaptureError>;

    /// `Some` when the OS pushes frames into the source, so the worker can
    /// sleep until one arrives. `None` is a pull source: every call captures,
    /// and the worker paces the calls.
    fn frame_signal(&self) -> Option<Arc<LatestFrame>> {
        None
    }
}

/// The newest frame a capture callback produced, and the wake-up for the
/// worker waiting on it.
#[derive(Debug, Default)]
pub struct LatestFrame {
    slot: Mutex<Option<Arc<CapturedFrame>>>,
    ready: Condvar,
}

// Only the macOS and Windows sources push frames; Linux capture is a pull source.
#[cfg_attr(not(any(target_os = "macos", target_os = "windows")), allow(dead_code))]
impl LatestFrame {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Option<Arc<CapturedFrame>>> {
        self.slot.lock().unwrap_or_else(|err| err.into_inner())
    }

    pub fn publish(&self, frame: CapturedFrame) {
        let replaced = self.lock().replace(Arc::new(frame));
        self.ready.notify_all();
        drop(replaced);
    }

    pub fn latest(&self) -> Result<Arc<CapturedFrame>, AmbilightCaptureError> {
        self.slot
            .lock()
            .map_err(|_| {
                AmbilightCaptureError::InvalidFrame("AMBILIGHT_CAPTURE_FRAME_LOCK_FAILED")
            })?
            .clone()
            .ok_or(AmbilightCaptureError::FrameUnavailable)
    }

    /// Wait at most `timeout` for a frame whose `seq` is not `seen`. `true`
    /// when there is one; the caller reads it with `capture_frame`.
    pub fn wait_newer(&self, seen: u64, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        let mut slot = self.lock();
        loop {
            if slot.as_ref().is_some_and(|frame| frame.seq != seen) {
                return true;
            }
            let now = Instant::now();
            if now >= deadline {
                return false;
            }
            slot = self
                .ready
                .wait_timeout(slot, deadline - now)
                .unwrap_or_else(|err| err.into_inner())
                .0;
        }
    }
}

/// Stable handle for a capture target enumerated by the platform adapter.
///
/// `id` must match the `DisplayInfoPayload.id` string produced by the
/// `list_displays` Tauri command so the frontend selection round-trips
/// losslessly. `is_primary` is the fallback beacon used by
/// [`select_display_index`] when the requested id is missing (display
/// unplugged / replugged with a different native handle, first launch
/// before the user has picked one, etc).
#[cfg_attr(
    not(any(target_os = "macos", target_os = "windows", target_os = "linux")),
    allow(dead_code)
)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DisplayCandidate {
    pub id: String,
    pub is_primary: bool,
}

/// Pick a display from `candidates` by matching the optional hint against
/// the stable `DisplayCandidate.id`. Falls back to the first primary
/// candidate, then the first candidate overall. Returns `None` only when
/// the list is empty (platform returned zero displays).
///
/// The primary-fallback rule is required for volatile native handles
/// (macOS `SCDisplay` ordering can change on replug, Windows `HMONITOR`
/// is recycled) — the worker must not fail hard when a persisted id no
/// longer resolves.
#[cfg_attr(
    not(any(target_os = "macos", target_os = "windows", target_os = "linux")),
    allow(dead_code)
)]
pub fn select_display_index(
    id_hint: Option<&str>,
    candidates: &[DisplayCandidate],
) -> Option<usize> {
    if candidates.is_empty() {
        return None;
    }

    if let Some(hint) = id_hint.and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    }) {
        if let Some(index) = candidates.iter().position(|candidate| candidate.id == hint) {
            return Some(index);
        }
    }

    if let Some(index) = candidates.iter().position(|candidate| candidate.is_primary) {
        return Some(index);
    }

    Some(0)
}

/// 20 Hz: the Hue streaming floor, and what capture ran at before the rate
/// followed the output plan.
pub const DEFAULT_CAPTURE_INTERVAL: Duration = Duration::from_millis(50);

pub fn create_live_frame_source(
    display_id: Option<&str>,
) -> Result<Box<dyn AmbilightFrameSource>, AmbilightCaptureError> {
    create_live_frame_source_at(display_id, DEFAULT_CAPTURE_INTERVAL)
}

/// `interval` is the shortest gap the OS is asked to leave between frames
/// (see `capture_interval_for` in `lighting_mode`). A pull source ignores it:
/// the worker paces its calls.
pub fn create_live_frame_source_at(
    display_id: Option<&str>,
    interval: Duration,
) -> Result<Box<dyn AmbilightFrameSource>, AmbilightCaptureError> {
    platform::create_live_frame_source(display_id, interval)
        .map(|source| Box::new(Counted::new(source)) as Box<dyn AmbilightFrameSource>)
}

// ---------------------------------------------------------------------------
// The app's own windows and the capture
// ---------------------------------------------------------------------------

/// Live capture sources running now. Where the preview cannot keep its twin
/// out of the capture (Linux, Windows before 10 2004), it hides the twin while
/// this is above zero, or Ambilight would light the strip from the twin.
static LIVE_SOURCES: AtomicUsize = AtomicUsize::new(0);

type CaptureListener = Box<dyn Fn(bool) + Send + Sync>;
static CAPTURE_LISTENER: OnceLock<CaptureListener> = OnceLock::new();

pub fn capture_active() -> bool {
    LIVE_SOURCES.load(Ordering::SeqCst) > 0
}

/// Called with `true` when the first live source starts and `false` when the
/// last one stops, on the thread that started or dropped it. Set once.
pub fn on_capture_active_changed(listener: CaptureListener) {
    let _ = CAPTURE_LISTENER.set(listener);
}

fn notify_capture_active(active: bool) {
    if let Some(listener) = CAPTURE_LISTENER.get() {
        listener(active);
    }
}

struct Counted(Box<dyn AmbilightFrameSource>);

impl Counted {
    fn new(inner: Box<dyn AmbilightFrameSource>) -> Self {
        if LIVE_SOURCES.fetch_add(1, Ordering::SeqCst) == 0 {
            notify_capture_active(true);
        }
        Self(inner)
    }
}

impl Drop for Counted {
    fn drop(&mut self) {
        if LIVE_SOURCES.fetch_sub(1, Ordering::SeqCst) == 1 {
            notify_capture_active(false);
        }
    }
}

impl AmbilightFrameSource for Counted {
    fn capture_frame(&mut self) -> Result<Arc<CapturedFrame>, AmbilightCaptureError> {
        self.0.capture_frame()
    }

    fn frame_signal(&self) -> Option<Arc<LatestFrame>> {
        self.0.frame_signal()
    }
}

/// Keep every window of this app out of the live capture, or let them back
/// in. The preview session turns it on while it is open, so its twin and
/// popup never light the strip. Only macOS filters by application; Windows
/// keeps the preview windows out per window (`preview::windows`), and Linux
/// cannot.
pub fn set_own_windows_excluded(excluded: bool) {
    #[cfg(target_os = "macos")]
    platform::set_own_windows_excluded(excluded);
    #[cfg(not(target_os = "macos"))]
    let _ = excluded;
}

/// The one window of this app the capture still sees while the app is left
/// out: the preview's scene, which Ambilight is there to light. A window
/// number (`CGWindowID`); the window must be on screen, or ScreenCaptureKit
/// does not list it. macOS only — elsewhere nothing leaves the app out.
pub fn set_capture_excepted_window(window: Option<u32>) {
    #[cfg(target_os = "macos")]
    platform::set_capture_excepted_window(window);
    #[cfg(not(target_os = "macos"))]
    let _ = window;
}

#[cfg(target_os = "windows")]
mod platform {
    use std::sync::Arc;
    use std::time::Duration;

    use windows_capture::capture::{
        CaptureControl, GraphicsCaptureApiError, GraphicsCaptureApiHandler,
    };
    use windows_capture::frame::Frame;
    use windows_capture::graphics_capture_api::{
        Error as CaptureApiError, GraphicsCaptureApi, InternalCaptureControl,
    };
    use windows_capture::monitor::Monitor;
    use windows_capture::settings::{
        ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
        MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
    };

    use super::{
        select_display_index, AmbilightCaptureError, AmbilightFrameSource, CapturedFrame,
        DisplayCandidate, LatestFrame,
    };

    type SharedFrame = Arc<LatestFrame>;

    /// Resolve a `Monitor` for the requested capture display.
    ///
    /// The stable id baked into `DisplayInfoPayload.id` on Windows is
    /// `"<device_name>:<x>:<y>"` where `device_name` is the OS form
    /// `\\.\DISPLAY<N>` returned by both Tauri's monitor API and
    /// `windows-capture::Monitor::device_name`. We enumerate monitors,
    /// reconstruct the same prefix via `device_name` (position is not
    /// exposed on windows-capture `Monitor`; Windows guarantees
    /// `\\.\DISPLAY<N>` uniqueness across active displays so the prefix
    /// alone suffices), and let [`select_display_index`] pick with
    /// primary fallback when the persisted id no longer resolves
    /// (monitor unplugged / replugged into a different `DISPLAY<N>`
    /// slot).
    fn resolve_monitor(display_id: Option<&str>) -> Result<Monitor, AmbilightCaptureError> {
        let monitors = Monitor::enumerate().map_err(|_| {
            AmbilightCaptureError::InvalidFrame("AMBILIGHT_CAPTURE_MONITOR_NOT_FOUND")
        })?;
        if monitors.is_empty() {
            return Err(AmbilightCaptureError::InvalidFrame(
                "AMBILIGHT_CAPTURE_MONITOR_NOT_FOUND",
            ));
        }

        let primary_device_name = Monitor::primary()
            .ok()
            .and_then(|monitor| monitor.device_name().ok());

        let candidates: Vec<DisplayCandidate> = monitors
            .iter()
            .map(|monitor| {
                let device = monitor.device_name().unwrap_or_default();
                let is_primary = primary_device_name
                    .as_deref()
                    .is_some_and(|primary| primary == device);
                DisplayCandidate {
                    id: device,
                    is_primary,
                }
            })
            .collect();

        // Strip trailing `":x:y"` so a persisted id from `list_displays`
        // matches the monitor's device_name after resolution / position
        // changes.
        let hint_device = display_id.and_then(|raw| {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                return None;
            }
            let head = trimmed.rsplitn(3, ':').nth(2).unwrap_or(trimmed);
            Some(head.to_string())
        });

        let index = select_display_index(hint_device.as_deref(), &candidates).ok_or(
            AmbilightCaptureError::InvalidFrame("AMBILIGHT_CAPTURE_MONITOR_NOT_FOUND"),
        )?;

        monitors
            .into_iter()
            .nth(index)
            .ok_or(AmbilightCaptureError::InvalidFrame(
                "AMBILIGHT_CAPTURE_MONITOR_NOT_FOUND",
            ))
    }

    pub(super) fn create_live_frame_source(
        display_id: Option<&str>,
        interval: Duration,
    ) -> Result<Box<dyn AmbilightFrameSource>, AmbilightCaptureError> {
        let latest_frame = LatestFrame::new();
        let monitor = resolve_monitor(display_id)?;
        // The rate the output plan asks for (20 or 30 Hz), same as macOS.
        //
        // `Default` leaves the WGC interval alone, which means `on_frame_arrived`
        // fires at the compositor's rate — 60, 144, 240 Hz — and every one of
        // those calls allocates a staging texture and does a full-resolution
        // GPU-to-CPU `CopyResource`. The worker paces what we
        // *consume*, not what Windows *produces*, so that cost never appeared in
        // the frame budget while being by far the largest thing in it. On a
        // 144 Hz display this is roughly a sevenfold reduction in readback for
        // byte-identical output.
        let start = |border| {
            WindowsLiveCaptureHandler::start_free_threaded(Settings::new(
                monitor,
                CursorCaptureSettings::Default,
                border,
                SecondaryWindowSettings::Default,
                MinimumUpdateIntervalSettings::Custom(interval),
                DirtyRegionSettings::Default,
                ColorFormat::Rgba8,
                Arc::clone(&latest_frame),
            ))
        };

        // A build denying the Borderless access windows-capture never requests keeps the frame
        // without an error. See docs/architecture/capture-and-pipeline.md.
        let border = if GraphicsCaptureApi::is_border_settings_supported().unwrap_or(false) {
            DrawBorderSettings::WithoutBorder
        } else {
            DrawBorderSettings::Default
        };
        let capture_control = match start(border) {
            Err(GraphicsCaptureApiError::GraphicsCaptureApiError(
                CaptureApiError::BorderConfigUnsupported,
            )) => {
                log::warn!(
                    "[ambilight-capture/windows] this build cannot drop the capture frame; capturing with it"
                );
                start(DrawBorderSettings::Default)
            }
            started => started,
        }
        .map_err(map_start_error)?;

        Ok(Box::new(WindowsLiveFrameSource {
            latest_frame,
            capture_control: Some(capture_control),
        }))
    }

    fn map_start_error(error: GraphicsCaptureApiError<&'static str>) -> AmbilightCaptureError {
        let code = match error {
            GraphicsCaptureApiError::FailedToJoinThread => "AMBILIGHT_CAPTURE_THREAD_JOIN_FAILED",
            GraphicsCaptureApiError::FailedToInitWinRT => "AMBILIGHT_CAPTURE_WINRT_INIT_FAILED",
            GraphicsCaptureApiError::FailedToCreateDispatcherQueueController => {
                "AMBILIGHT_CAPTURE_DISPATCHER_INIT_FAILED"
            }
            GraphicsCaptureApiError::FailedToShutdownDispatcherQueue => {
                "AMBILIGHT_CAPTURE_DISPATCHER_SHUTDOWN_FAILED"
            }
            GraphicsCaptureApiError::FailedToSetDispatcherQueueCompletedHandler => {
                "AMBILIGHT_CAPTURE_DISPATCHER_CALLBACK_FAILED"
            }
            GraphicsCaptureApiError::ItemConvertFailed => {
                "AMBILIGHT_CAPTURE_ITEM_CONVERSION_FAILED"
            }
            GraphicsCaptureApiError::DirectXError(_) => "AMBILIGHT_CAPTURE_D3D_INIT_FAILED",
            GraphicsCaptureApiError::GraphicsCaptureApiError(_) => {
                "AMBILIGHT_CAPTURE_SESSION_START_FAILED"
            }
            GraphicsCaptureApiError::FailedToRunMessageLoop => {
                "AMBILIGHT_CAPTURE_MESSAGE_LOOP_FAILED"
            }
            GraphicsCaptureApiError::FailedToStartCaptureThread => {
                "AMBILIGHT_CAPTURE_THREAD_START_FAILED"
            }
            GraphicsCaptureApiError::NewHandlerError(code)
            | GraphicsCaptureApiError::FrameHandlerError(code) => code,
        };

        AmbilightCaptureError::InvalidFrame(code)
    }

    struct WindowsLiveFrameSource {
        latest_frame: SharedFrame,
        capture_control: Option<CaptureControl<WindowsLiveCaptureHandler, &'static str>>,
    }

    impl Drop for WindowsLiveFrameSource {
        fn drop(&mut self) {
            // stop() joins the WGC thread; detach so this Drop stays
            // non-blocking. See docs/architecture/capture-and-pipeline.md.
            if let Some(capture_control) = self.capture_control.take() {
                let _ = std::thread::Builder::new()
                    .name("wgc-stop".into())
                    .spawn(move || {
                        let _ = capture_control.stop();
                    });
            }
        }
    }

    impl AmbilightFrameSource for WindowsLiveFrameSource {
        fn capture_frame(&mut self) -> Result<Arc<CapturedFrame>, AmbilightCaptureError> {
            self.latest_frame.latest()
        }

        fn frame_signal(&self) -> Option<Arc<LatestFrame>> {
            Some(Arc::clone(&self.latest_frame))
        }
    }

    struct WindowsLiveCaptureHandler {
        latest_frame: SharedFrame,
    }

    impl GraphicsCaptureApiHandler for WindowsLiveCaptureHandler {
        type Flags = SharedFrame;
        type Error = &'static str;

        fn new(ctx: windows_capture::capture::Context<Self::Flags>) -> Result<Self, Self::Error> {
            Ok(Self {
                latest_frame: ctx.flags,
            })
        }

        fn on_frame_arrived(
            &mut self,
            frame: &mut Frame,
            _capture_control: InternalCaptureControl,
        ) -> Result<(), Self::Error> {
            let width = frame.width();
            let height = frame.height();
            let frame_buffer = frame
                .buffer()
                .map_err(|_| "AMBILIGHT_CAPTURE_FRAME_BUFFER_FAILED")?;
            // windows-capture 2.0: `as_nopadding_buffer` now takes a scratch
            // `&mut Vec<u8>` the crate may resize+copy into when the source
            // frame has row padding (and returns the inner slice unchanged
            // when it does not). The previous 1.5 API returned
            // `Result<&[u8], _>`; we adopt the new shape with a stack-local
            // scratch buffer because the no-padding hot path is the common
            // case and the allocation only happens on padded frames.
            let mut nopad_scratch: Vec<u8> = Vec::new();
            let raw_pixels = frame_buffer.as_nopadding_buffer(&mut nopad_scratch);
            let expected_len = (width as usize)
                .saturating_mul(height as usize)
                .saturating_mul(4);

            if raw_pixels.len() < expected_len {
                return Err("AMBILIGHT_CAPTURE_PIXEL_BUFFER_INVALID");
            }

            // CPU-side downscale scaffold — no GPU hint on this platform.
            // See docs/architecture/capture-and-pipeline.md.
            let stride = super::downscale_stride(width, height);
            let (out_w, out_h) = super::downscaled_dimensions(width, height, stride);
            if stride > 1 {
                log::debug!(
                    "[ambilight-capture/windows] 4K downscale active: src={}x{} stride={} → ~{}x{}",
                    width,
                    height,
                    stride,
                    out_w,
                    out_h,
                );
            }

            let pixels_rgb = super::subsample_rgb(
                &raw_pixels[..expected_len],
                width as usize,
                height as usize,
                stride,
            );

            self.latest_frame
                .publish(CapturedFrame::new(out_w, out_h, pixels_rgb));

            Ok(())
        }
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    use screencapturekit::cv::CVPixelBufferLockFlags;
    use screencapturekit::prelude::*;

    use super::super::screen_capture_permission::ensure_screen_capture_access;
    use super::{
        select_display_index, AmbilightCaptureError, AmbilightFrameSource, CapturedFrame,
        DisplayCandidate, LatestFrame,
    };

    type SharedFrame = Arc<LatestFrame>;

    #[repr(C)]
    struct MachTimebaseInfo {
        numer: u32,
        denom: u32,
    }

    extern "C" {
        fn mach_absolute_time() -> u64;
        fn mach_timebase_info(info: *mut MachTimebaseInfo) -> i32;
    }

    /// How long ago a host-clock time (`mach_absolute_time` ticks, as
    /// `SCStreamFrameInfo.displayTime` is) was. `None` for a time not in the
    /// past, or one too far back to be a frame's (a clock the frame does not
    /// share would read as seconds).
    fn host_time_age(then: u64) -> Option<Duration> {
        static TIMEBASE: std::sync::OnceLock<(u64, u64)> = std::sync::OnceLock::new();
        let &(numer, denom) = TIMEBASE.get_or_init(|| {
            let mut info = MachTimebaseInfo { numer: 0, denom: 0 };
            // SAFETY: fills the struct it is given; it cannot fail on macOS.
            unsafe { mach_timebase_info(&mut info) };
            (u64::from(info.numer.max(1)), u64::from(info.denom.max(1)))
        });
        // SAFETY: reads the host clock.
        let now = unsafe { mach_absolute_time() };
        let ticks = now.checked_sub(then)?;
        let age = Duration::from_nanos(ticks.saturating_mul(numer) / denom);
        (age < Duration::from_millis(500)).then_some(age)
    }

    /// Resolve the SCDisplay matching the persisted `display_id` hint,
    /// falling back to the primary (main) display on any mismatch.
    ///
    /// `DisplayInfoPayload.id` on macOS is `"<tao-name>:<x>:<y>"` where
    /// `tao-name` is `"Monitor #<model>"`. `SCDisplay` does not expose
    /// model number, so we use the trailing `"<x>:<y>"` portion as the
    /// stable key — logical origin coordinates are available on both
    /// `SCDisplay.frame()` and Tauri's `available_monitors()` and remain
    /// stable while a display stays connected. On unplug/replug the
    /// persisted id stops matching and we revert to primary via
    /// `CGMainDisplayID`.
    fn select_display(display_id: Option<&str>) -> Result<SCDisplay, AmbilightCaptureError> {
        // The only caller allowed to prompt — see screen_capture_permission.
        if ensure_screen_capture_access().blocks_capture() {
            return Err(AmbilightCaptureError::InvalidFrame(
                "AMBILIGHT_CAPTURE_PERMISSION_DENIED",
            ));
        }

        // Permission is granted, so a failure here is ScreenCaptureKit itself
        // (typically a wedged `replayd`), never consent.
        let content = SCShareableContent::get().map_err(|_| {
            AmbilightCaptureError::InvalidFrame("AMBILIGHT_CAPTURE_SHAREABLE_CONTENT_FAILED")
        })?;

        let displays = content.displays();
        if displays.is_empty() {
            return Err(AmbilightCaptureError::InvalidFrame(
                "AMBILIGHT_CAPTURE_MONITOR_NOT_FOUND",
            ));
        }

        let main_id = unsafe { main_display_id_ffi() };

        let candidates: Vec<DisplayCandidate> = displays
            .iter()
            .map(|display| {
                let frame = display.frame();
                let origin = frame.origin();
                let x = origin.x.round() as i32;
                let y = origin.y.round() as i32;
                let is_primary = display.display_id() == main_id;
                DisplayCandidate {
                    id: format!("{}:{}", x, y),
                    is_primary,
                }
            })
            .collect();

        // Reduce the incoming Tauri id to `"<x>:<y>"` so it matches our
        // position-keyed candidates.
        let hint_key = display_id.and_then(|raw| {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                return None;
            }
            let tokens: Vec<&str> = trimmed.rsplitn(3, ':').collect();
            // rsplitn yields tokens in reverse order; when `name:x:y`
            // is supplied, tokens = ["y", "x", "name"] so the first two
            // entries form the stable key.
            if tokens.len() >= 2 {
                Some(format!("{}:{}", tokens[1], tokens[0]))
            } else {
                None
            }
        });

        let index = select_display_index(hint_key.as_deref(), &candidates).ok_or(
            AmbilightCaptureError::InvalidFrame("AMBILIGHT_CAPTURE_MONITOR_NOT_FOUND"),
        )?;

        displays
            .into_iter()
            .nth(index)
            .ok_or(AmbilightCaptureError::InvalidFrame(
                "AMBILIGHT_CAPTURE_MONITOR_NOT_FOUND",
            ))
    }

    /// Thin wrapper over CoreGraphics `CGMainDisplayID`. Declared inline
    /// to keep the macOS capture surface self-contained; the same call
    /// is used by tao/winit for primary detection so behaviour matches
    /// what `list_displays` considers primary.
    unsafe fn main_display_id_ffi() -> u32 {
        extern "C" {
            fn CGMainDisplayID() -> u32;
        }
        unsafe { CGMainDisplayID() }
    }

    pub(super) fn create_live_frame_source(
        display_id: Option<&str>,
        interval: Duration,
    ) -> Result<Box<dyn AmbilightFrameSource>, AmbilightCaptureError> {
        let display = select_display(display_id)?;

        let start_failed =
            |_| AmbilightCaptureError::InvalidFrame("AMBILIGHT_CAPTURE_SESSION_START_FAILED");

        // Read, not held: a start can take seconds, and the main thread waits
        // on this lock when a preview opens or closes. A flag that changes
        // while the stream starts is reconciled when it registers.
        let wanted = FILTER_STATE
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .wanted;
        let (filter, applied) = build_filter(&display, wanted).map_err(start_failed)?;

        // Downscale to ~640px max dimension for ambilight color sampling.
        // SCStream performs hardware-accelerated scaling on the GPU — zero extra CPU cost.
        // Full resolution (e.g. 2560x1600) wastes CPU on BGRA→RGB conversion,
        // frame cloning, and pixel iteration. ~640x400 is more than sufficient
        // for averaging colors in screen regions.
        let native_w = display.width();
        let native_h = display.height();
        let (capture_width, capture_height) = if native_w.max(native_h) > super::MAX_CAPTURE_DIM {
            let scale = native_w.max(native_h) / super::MAX_CAPTURE_DIM;
            ((native_w / scale).max(1), (native_h / scale).max(1))
        } else {
            (native_w, native_h)
        };

        // The output plan's rate (20 Hz for Hue alone, 30 with a strip).
        let frame_interval = CMTime::new(interval.as_millis().clamp(1, 1000) as i64, 1000);

        let config = SCStreamConfiguration::new()
            .with_width(capture_width)
            .with_height(capture_height)
            .with_pixel_format(PixelFormat::BGRA)
            .with_shows_cursor(false)
            .with_minimum_frame_interval(&frame_interval);

        let latest_frame: SharedFrame = LatestFrame::new();
        let frame_writer = Arc::clone(&latest_frame);

        let mut stream = SCStream::new(&filter, &config).map_err(start_failed)?;

        let registered = stream.add_output_handler(
            move |sample: CMSampleBuffer, of_type: SCStreamOutputType| {
                if of_type != SCStreamOutputType::Screen {
                    return;
                }
                // Stamped before the conversion below, which takes a few
                // milliseconds, and moved back to when the display showed the
                // frame where ScreenCaptureKit says.
                let arrived = Instant::now();
                let captured_at = sample
                    .display_time()
                    .and_then(host_time_age)
                    .and_then(|age| arrived.checked_sub(age))
                    .unwrap_or(arrived);

                let buffer = match sample.pixel_buffer() {
                    Some(buf) => buf,
                    None => return,
                };

                let guard = match buffer.lock(CVPixelBufferLockFlags::READ_ONLY) {
                    Ok(g) => g,
                    Err(_) => return,
                };

                let width = guard.width() as u32;
                let height = guard.height() as u32;
                let bytes_per_row = guard.bytes_per_row();
                // SAFETY: the READ_ONLY lock is held by `guard` for the slice's whole
                // lifetime, we never unlock manually, and nothing here writes to it.
                let raw_data = match unsafe { guard.as_slice() } {
                    Some(data) => data,
                    None => return,
                };

                if width == 0 || height == 0 || raw_data.is_empty() {
                    return;
                }

                let pixel_count = (width as usize).saturating_mul(height as usize);
                let mut pixels_rgb = Vec::with_capacity(pixel_count);

                // BGRA pixel data — rows may have padding (bytes_per_row > width * 4)
                for y in 0..height as usize {
                    let row_start = y * bytes_per_row;
                    for x in 0..width as usize {
                        let offset = row_start + x * 4;
                        if offset + 3 <= raw_data.len() {
                            // BGRA → RGB
                            pixels_rgb.push([
                                raw_data[offset + 2], // R
                                raw_data[offset + 1], // G
                                raw_data[offset],     // B
                            ]);
                        }
                    }
                }

                let mut frame = CapturedFrame::new(width, height, pixels_rgb);
                frame.captured_at = captured_at;
                frame_writer.publish(frame);
            },
            SCStreamOutputType::Screen,
        );
        // A refused handler would start a stream that never delivers a frame.
        registered.map_err(start_failed)?;

        stream.start_capture().map_err(start_failed)?;

        let id = NEXT_STREAM_ID.fetch_add(1, Ordering::Relaxed);
        let mut state = FILTER_STATE.lock().unwrap_or_else(|e| e.into_inner());
        state.live = Some(LiveStream {
            id,
            stream: stream.clone(),
            display,
            applied,
        });
        let wanted = state.wanted;
        reconcile(&mut state, wanted);
        drop(state);

        Ok(Box::new(MacOSLiveFrameSource {
            latest_frame,
            stream,
            id,
        }))
    }

    /// The running stream and what it should leave out of the display. An
    /// update never reaches a stream its source has let go of: both go through
    /// this lock.
    struct FilterState {
        wanted: OwnWindows,
        live: Option<LiveStream>,
    }

    /// Whether this app's windows are left out, and the one still captured.
    #[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
    struct OwnWindows {
        exclude: bool,
        except: Option<u32>,
    }

    struct LiveStream {
        id: u64,
        stream: SCStream,
        display: SCDisplay,
        /// What the stream's filter actually does, which can fall short of
        /// `wanted` when the app or the window was not found.
        applied: OwnWindows,
    }

    static FILTER_STATE: Mutex<FilterState> = Mutex::new(FilterState {
        wanted: OwnWindows {
            exclude: false,
            except: None,
        },
        live: None,
    });
    static NEXT_STREAM_ID: AtomicU64 = AtomicU64::new(1);

    /// The whole display, or the whole display less this app's windows, and
    /// whether it left the app out. The app is looked up among off-screen
    /// windows too, since the main window may be hidden; whether a windowless
    /// moment still lists it is unverified, so the caller retries once the
    /// twin exists.
    fn build_filter(
        display: &SCDisplay,
        wanted: OwnWindows,
    ) -> Result<(SCContentFilter, OwnWindows), SCError> {
        if wanted.exclude {
            let own_pid = std::process::id() as i32;
            let content = SCShareableContent::create()
                .with_on_screen_windows_only(false)
                .get()?;
            if let Some(app) = content
                .applications()
                .into_iter()
                .find(|app| app.process_id() == own_pid)
            {
                let excepted = wanted.except.and_then(|id| {
                    let found = content.windows().into_iter().find(|w| w.window_id() == id);
                    if found.is_none() {
                        log::warn!("[capture] window {id} is not shareable yet; it stays out of the capture");
                    }
                    found
                });
                let filter = SCContentFilter::create()
                    .with_display(display)
                    .with_excluding_applications(&[&app], &excepted.iter().collect::<Vec<_>>())
                    .build()?;
                let applied = OwnWindows {
                    exclude: true,
                    except: excepted.as_ref().map(|w| w.window_id()),
                };
                log::info!(
                    "[capture] filter leaves out this app's windows (pid {own_pid}) except {:?}",
                    applied.except
                );
                return Ok((filter, applied));
            }
            log::warn!(
                "[capture] this app is not among the shareable applications; its windows stay in the capture"
            );
        }
        let filter = SCContentFilter::create()
            .with_display(display)
            .with_excluding_windows(&[])
            .build()?;
        Ok((filter, OwnWindows::default()))
    }

    /// Bring the running stream's filter to `wanted`, if it is not there.
    fn reconcile(state: &mut FilterState, wanted: OwnWindows) {
        let Some(live) = state.live.as_mut() else {
            return;
        };
        if live.applied == wanted {
            return;
        }
        let applied = build_filter(&live.display, wanted).and_then(|(filter, applied)| {
            live.stream.update_content_filter(&filter)?;
            Ok(applied)
        });
        match applied {
            Ok(applied) => {
                live.applied = applied;
                log::info!("[capture] own windows {applied:?} on the running stream");
            }
            Err(error) => {
                log::warn!("[capture] own windows {wanted:?} not applied: {error:?}")
            }
        }
    }

    /// Applied to the running stream at once, blocking until ScreenCaptureKit
    /// confirms, so a window shown after this returns is never in a frame.
    /// With no stream running nothing is asked of ScreenCaptureKit: listing
    /// the shareable content is what raises the Screen Recording prompt, which
    /// only a capture start may do. Calling it again with the same value
    /// retries a filter that could not leave the app out.
    pub(super) fn set_own_windows_excluded(excluded: bool) {
        let mut state = FILTER_STATE.lock().unwrap_or_else(|e| e.into_inner());
        state.wanted.exclude = excluded;
        let wanted = state.wanted;
        reconcile(&mut state, wanted);
    }

    /// Applied like `set_own_windows_excluded`, blocking until it is.
    pub(super) fn set_capture_excepted_window(window: Option<u32>) {
        let mut state = FILTER_STATE.lock().unwrap_or_else(|e| e.into_inner());
        state.wanted.except = window;
        let wanted = state.wanted;
        reconcile(&mut state, wanted);
    }

    struct MacOSLiveFrameSource {
        latest_frame: SharedFrame,
        stream: SCStream,
        id: u64,
    }

    impl Drop for MacOSLiveFrameSource {
        fn drop(&mut self) {
            {
                let mut state = FILTER_STATE.lock().unwrap_or_else(|e| e.into_inner());
                if state.live.as_ref().is_some_and(|live| live.id == self.id) {
                    state.live = None;
                }
            }
            // SCStream::Drop only calls sc_stream_release (not sc_stream_stop_capture).
            // Releasing a capturing stream without stopping it first causes a macOS crash.
            //
            // We clone the stream (Swift retain +1) and stop it on a dedicated thread so
            // this Drop returns immediately and does not freeze the Tauri command thread.
            //
            // RACE CONDITION: after stop_capture() returns, the macOS DispatchQueue may
            // still have in-flight sample_handler callbacks that reference StreamContext.
            // If we drop the clone immediately after stop_capture(), StreamContext reaches
            // ref-count 0 and is freed while those callbacks are still running → SIGBUS.
            //
            // Fix: sleep 150 ms after stop_capture() so the DispatchQueue drains before
            // StreamContext is freed (clone dropped at end of closure).
            let stream = self.stream.clone();
            let _ = std::thread::Builder::new()
                .name("sc-stream-stop".into())
                .spawn(move || {
                    let _ = stream.stop_capture();
                    // Grace period: let macOS DispatchQueue drain any pending
                    // sample_handler callbacks before StreamContext is freed.
                    std::thread::sleep(std::time::Duration::from_millis(150));
                    // stream dropped here → StreamContext ref 0 → safe.
                });
        }
    }

    impl AmbilightFrameSource for MacOSLiveFrameSource {
        fn capture_frame(&mut self) -> Result<Arc<CapturedFrame>, AmbilightCaptureError> {
            self.latest_frame.latest()
        }

        fn frame_signal(&self) -> Option<Arc<LatestFrame>> {
            Some(Arc::clone(&self.latest_frame))
        }
    }

    // Safety: SCStream is created and owned; the Arc<Mutex<>> shared state is Send+Sync.
    // The closure handler is moved into SCStream which manages its own dispatch queue.
    unsafe impl Send for MacOSLiveFrameSource {}
}

#[cfg(target_os = "linux")]
mod platform {
    use std::sync::Arc;

    use xcap::Monitor;

    use super::{
        select_display_index, AmbilightCaptureError, AmbilightFrameSource, CapturedFrame,
        DisplayCandidate,
    };

    /// Resolve an `xcap::Monitor` for the requested capture display.
    ///
    /// `DisplayInfoPayload.id` on Linux is `"<name>:<x>:<y>"` where `name` is
    /// the xrandr output name (e.g. `"HDMI-1"`, `"eDP-1"`) returned by both
    /// Tauri's `available_monitors()` and `xcap::Monitor::name()` — both
    /// resolve through libxcb/RandR so the values match. We strip the
    /// trailing `":x:y"` and feed the prefix to [`select_display_index`]
    /// with primary fallback for unplugged / re-routed outputs.
    fn resolve_monitor(display_id: Option<&str>) -> Result<Monitor, AmbilightCaptureError> {
        let monitors = Monitor::all().map_err(|_| {
            AmbilightCaptureError::InvalidFrame("AMBILIGHT_CAPTURE_MONITOR_NOT_FOUND")
        })?;
        if monitors.is_empty() {
            return Err(AmbilightCaptureError::InvalidFrame(
                "AMBILIGHT_CAPTURE_MONITOR_NOT_FOUND",
            ));
        }

        let candidates: Vec<DisplayCandidate> = monitors
            .iter()
            .map(|monitor| {
                let name = monitor.name().unwrap_or_default();
                let is_primary = monitor.is_primary().unwrap_or(false);
                DisplayCandidate {
                    id: name,
                    is_primary,
                }
            })
            .collect();

        // Strip trailing `":x:y"` so a persisted id from `list_displays`
        // matches the bare xrandr output name after resolution / position
        // changes.
        let hint_name = display_id.and_then(|raw| {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                return None;
            }
            let head = trimmed.rsplitn(3, ':').nth(2).unwrap_or(trimmed);
            Some(head.to_string())
        });

        let index = select_display_index(hint_name.as_deref(), &candidates).ok_or(
            AmbilightCaptureError::InvalidFrame("AMBILIGHT_CAPTURE_MONITOR_NOT_FOUND"),
        )?;

        monitors
            .into_iter()
            .nth(index)
            .ok_or(AmbilightCaptureError::InvalidFrame(
                "AMBILIGHT_CAPTURE_MONITOR_NOT_FOUND",
            ))
    }

    pub(super) fn create_live_frame_source(
        display_id: Option<&str>,
        _interval: std::time::Duration,
    ) -> Result<Box<dyn AmbilightFrameSource>, AmbilightCaptureError> {
        let monitor = resolve_monitor(display_id)?;
        Ok(Box::new(LinuxFrameSource {
            monitor,
            downscale_logged: false,
        }))
    }

    /// Pull-mode frame source. xcap does not expose a streaming/callback
    /// API on Linux (X11 / Wayland share the same blocking
    /// `capture_image` surface), so each `capture_frame` call performs a
    /// fresh xrandr-driven grab. The ambilight worker paces calls at the
    /// output plan's capture rate, the same rate macOS and Windows are asked
    /// for.
    ///
    /// X11 is the supported configuration. xcap auto-detects Wayland and
    /// falls through to PipeWire / xdg-desktop-portal underneath; we do not
    /// block that and make no promises about it. No release is named here on
    /// purpose — see `docs/architecture/capture-and-pipeline.md`.
    struct LinuxFrameSource {
        monitor: Monitor,
        /// Pull mode runs ~20×/s, so Windows' per-frame downscale log would
        /// be 20 lines a second here. One line per frame source says as much.
        downscale_logged: bool,
    }

    impl AmbilightFrameSource for LinuxFrameSource {
        fn capture_frame(&mut self) -> Result<Arc<CapturedFrame>, AmbilightCaptureError> {
            let image = self.monitor.capture_image().map_err(|_| {
                AmbilightCaptureError::InvalidFrame("AMBILIGHT_CAPTURE_FRAME_BUFFER_FAILED")
            })?;

            let width = image.width();
            let height = image.height();

            if width == 0 || height == 0 {
                return Err(AmbilightCaptureError::InvalidFrame(
                    "AMBILIGHT_CAPTURE_PIXEL_BUFFER_INVALID",
                ));
            }

            let raw_pixels = image.as_raw();
            let expected_len = (width as usize)
                .saturating_mul(height as usize)
                .saturating_mul(4);

            if raw_pixels.len() < expected_len {
                return Err(AmbilightCaptureError::InvalidFrame(
                    "AMBILIGHT_CAPTURE_PIXEL_BUFFER_INVALID",
                ));
            }

            // CPU-side downscale — xcap has no output-size hint, so this is
            // the same stride arithmetic the Windows path runs.
            let stride = super::downscale_stride(width, height);
            let (out_w, out_h) = super::downscaled_dimensions(width, height, stride);
            if stride > 1 && !self.downscale_logged {
                self.downscale_logged = true;
                log::debug!(
                    "[ambilight-capture/linux] downscale active: src={}x{} stride={} → ~{}x{}",
                    width,
                    height,
                    stride,
                    out_w,
                    out_h,
                );
            }

            let pixels_rgb = super::subsample_rgb(
                &raw_pixels[..expected_len],
                width as usize,
                height as usize,
                stride,
            );

            Ok(Arc::new(CapturedFrame::new(out_w, out_h, pixels_rgb)))
        }
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
mod platform {
    use super::{AmbilightCaptureError, AmbilightFrameSource};

    pub(super) fn create_live_frame_source(
        _display_id: Option<&str>,
        _interval: std::time::Duration,
    ) -> Result<Box<dyn AmbilightFrameSource>, AmbilightCaptureError> {
        Err(AmbilightCaptureError::InvalidFrame(
            "AMBILIGHT_CAPTURE_UNSUPPORTED_PLATFORM",
        ))
    }
}

/// Detected black border insets, expressed as fractions of the frame dimensions.
///
/// Each field is in [0.0, 0.5]. A zero value means no border was found on
/// that edge. The strip, Hue and scene-stage sampling all shrink their bounds
/// by these insets.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct BlackBorderInsets {
    pub top: f32,
    pub bottom: f32,
    pub left: f32,
    pub right: f32,
}

impl BlackBorderInsets {
    /// The picture inside the bars of a `width`×`height` frame, as half-open
    /// pixel ranges `(rows, cols)`. Never empty, so a frame the detector
    /// reads as all border still has one row and column to sample.
    pub fn content_bounds(
        &self,
        width: usize,
        height: usize,
    ) -> (std::ops::Range<usize>, std::ops::Range<usize>) {
        let top = (height as f32 * self.top).round() as usize;
        let bottom = height
            .saturating_sub((height as f32 * self.bottom).round() as usize)
            .max(top + 1);
        let left = (width as f32 * self.left).round() as usize;
        let right = width
            .saturating_sub((width as f32 * self.right).round() as usize)
            .max(left + 1);
        (top..bottom, left..right)
    }
}

const BORDER_SCAN_STEP: usize = 8;
const BORDER_MAX_INSET: f32 = 0.40;

/// Brightness above which a pixel counts as content rather than letterbox, on
/// a frame whose bars are true black. Lives here, next to the detector,
/// because the live worker and the debug capture probe have to read the same
/// number for their answers to be comparable — a probe measuring a different
/// threshold measures nothing.
pub const BLACK_BORDER_THRESHOLD: u8 = 15;

/// The brightest a bar can be. A player that leaves video in limited range
/// draws its bars at 16, not 0, so the threshold follows the darkest edge's
/// own black up to here — and only for a flat edge: a dim picture or a dark
/// interface is uneven, and raising the threshold under it would crop it.
const BORDER_BLACK_CEILING: u8 = 24;
/// How much a bar's edge may vary and still be read as one flat black.
const BORDER_BLACK_FLATNESS: u8 = 4;
/// How far above that black a pixel must be to count as picture.
const BORDER_BLACK_MARGIN: u8 = 8;
/// A line is picture only with this many samples above the threshold, so a
/// cursor, a stray bright pixel or compression noise in a bar is not.
const BORDER_MIN_HITS: usize = 2;
/// Opposite bars further apart than this, in scan steps, are not one bar
/// drawn twice: something in one of them is not bar.
const BORDER_SYMMETRY_STEPS: usize = 2;
/// Bottom-bar content that stays inside this middle share of the width reads
/// as subtitles over the bar, not as picture.
const BORDER_SUBTITLE_SPAN: f32 = 0.85;

/// Samples above `threshold` along one row: how many, and the first and last
/// column they were found at.
fn row_hits(pixels: &[[u8; 3]], w: usize, row: usize, threshold: u8) -> (usize, usize, usize) {
    let mut hits = 0;
    let (mut first, mut last) = (usize::MAX, 0);
    for col in (0..w).step_by(BORDER_SCAN_STEP) {
        if let Some(pixel) = pixels.get(row * w + col) {
            if pixel[0].max(pixel[1]).max(pixel[2]) > threshold {
                hits += 1;
                first = first.min(col);
                last = col;
            }
        }
    }
    (hits, first, last)
}

fn row_has_content(pixels: &[[u8; 3]], w: usize, row: usize, threshold: u8) -> bool {
    row_hits(pixels, w, row, threshold).0 >= BORDER_MIN_HITS
}

fn col_has_content(pixels: &[[u8; 3]], w: usize, h: usize, col: usize, threshold: u8) -> bool {
    let mut hits = 0;
    for row in (0..h).step_by(BORDER_SCAN_STEP) {
        if let Some(pixel) = pixels.get(row * w + col) {
            if pixel[0].max(pixel[1]).max(pixel[2]) > threshold {
                hits += 1;
                if hits >= BORDER_MIN_HITS {
                    return true;
                }
            }
        }
    }
    false
}

/// The darkest and brightest sample along each of the frame's outermost rows
/// and columns.
fn edge_ranges(pixels: &[[u8; 3]], w: usize, h: usize) -> [(u8, u8); 4] {
    let range = |cells: &mut dyn Iterator<Item = usize>| {
        cells
            .filter_map(|i| pixels.get(i))
            .map(|p| p[0].max(p[1]).max(p[2]))
            .fold((u8::MAX, 0), |(lo, hi), v| (lo.min(v), hi.max(v)))
    };
    [
        range(&mut (0..w).step_by(BORDER_SCAN_STEP)),
        range(&mut (0..w).step_by(BORDER_SCAN_STEP).map(|c| (h - 1) * w + c)),
        range(&mut (0..h).step_by(BORDER_SCAN_STEP).map(|r| r * w)),
        range(&mut (0..h).step_by(BORDER_SCAN_STEP).map(|r| r * w + w - 1)),
    ]
}

/// Depth of the bar on each edge, in pixels: the first scanned line with
/// picture on it, or `None` when no line has any.
fn edge_depths(px: &[[u8; 3]], w: usize, h: usize, threshold: u8) -> Option<[usize; 4]> {
    let top = (0..h)
        .step_by(BORDER_SCAN_STEP)
        .find(|&row| row_has_content(px, w, row, threshold))?;
    let bottom = (0..h)
        .step_by(BORDER_SCAN_STEP)
        .find(|&depth| row_has_content(px, w, h - 1 - depth, threshold))?;
    let left = (0..w)
        .step_by(BORDER_SCAN_STEP)
        .find(|&col| col_has_content(px, w, h, col, threshold))?;
    let right = (0..w)
        .step_by(BORDER_SCAN_STEP)
        .find(|&depth| col_has_content(px, w, h, w - 1 - depth, threshold))?;
    Some([top, bottom, left, right])
}

/// One bar depth for two opposite edges. A bar on one side only is dark
/// picture, not a bar: players centre the picture, so real bars come in pairs.
/// A pair that disagrees takes the shallower depth, so no picture is cropped —
/// except where `subtitles` says the bottom's extra content is a subtitle line
/// over the bar, when the top's depth holds for both.
fn paired_depth(near: usize, far: usize, subtitles: impl FnOnce() -> bool) -> usize {
    if near == 0 || far == 0 {
        return 0;
    }
    if near.abs_diff(far) <= BORDER_SYMMETRY_STEPS * BORDER_SCAN_STEP {
        return near.min(far);
    }
    if far < near && subtitles() {
        return near;
    }
    near.min(far)
}

/// Whether the content the bottom scan met between `depths` (from the bottom
/// edge) is a subtitle over the bar: every line of it inside the middle of the
/// width, and bar again between it and the picture. A lit object at the
/// bottom of a picture whose top is dark runs on into the picture instead.
fn band_is_subtitles(
    px: &[[u8; 3]],
    w: usize,
    h: usize,
    depths: std::ops::Range<usize>,
    threshold: u8,
) -> bool {
    let margin = ((1.0 - BORDER_SUBTITLE_SPAN) / 2.0 * w as f32) as usize;
    let (mut text, mut gap) = (false, false);
    for depth in depths.step_by(BORDER_SCAN_STEP) {
        let (hits, first, last) = row_hits(px, w, h - 1 - depth, threshold);
        if hits < BORDER_MIN_HITS {
            gap |= text;
        } else if gap || first < margin || last + margin >= w {
            return false;
        } else {
            text = true;
        }
    }
    text && gap
}

/// Detect letterbox / pillarbox black borders in `frame`.
///
/// Scans inward from each edge (every `BORDER_SCAN_STEP` pixels for speed)
/// until a line with picture on it is found, then pairs opposite edges (see
/// [`paired_depth`]). Returns the insets as fractions of the frame dimensions,
/// capped at `BORDER_MAX_INSET`, or `None` for a frame with nothing to measure
/// against — black, or too dark to tell — so the caller keeps its last answer
/// instead of dropping the crop through a fade.
pub fn detect_black_borders(frame: &CapturedFrame, threshold: u8) -> Option<BlackBorderInsets> {
    let w = frame.width as usize;
    let h = frame.height as usize;
    if w == 0 || h == 0 || frame.pixels_rgb.len() < w * h {
        return None;
    }
    let px = frame.pixels_rgb.as_slice();

    let (darkest_lo, darkest_hi) = edge_ranges(px, w, h)
        .into_iter()
        .min_by_key(|&(_, hi)| hi)
        .unwrap_or((0, 0));
    if darkest_hi > BORDER_BLACK_CEILING {
        // Picture on all four edges: no bars.
        return Some(BlackBorderInsets::default());
    }
    let flat = darkest_hi - darkest_lo <= BORDER_BLACK_FLATNESS;
    let threshold = if flat {
        threshold.max(darkest_hi.saturating_add(BORDER_BLACK_MARGIN))
    } else {
        threshold
    };
    let [top, bottom, left, right] = edge_depths(px, w, h, threshold)?;

    let letterbox = paired_depth(top, bottom, || {
        band_is_subtitles(px, w, h, bottom..top, threshold)
    });
    let pillarbox = paired_depth(left, right, || false);
    let rows = (letterbox as f32 / h as f32).min(BORDER_MAX_INSET);
    let cols = (pillarbox as f32 / w as f32).min(BORDER_MAX_INSET);
    Some(BlackBorderInsets {
        top: rows,
        bottom: rows,
        left: cols,
        right: cols,
    })
}

#[cfg(test)]
mod tests {
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    use super::{create_live_frame_source, AmbilightCaptureError};
    use super::{
        downscale_stride, downscaled_dimensions, select_display_index, subsample_rgb,
        DisplayCandidate, MAX_CAPTURE_DIM,
    };

    /// Where the twin cannot be excluded it hides while capture runs, so the
    /// count must cover a source's whole life and two sources must not end
    /// it early.
    #[test]
    fn capture_is_active_while_any_live_source_lives() {
        struct Idle;
        impl super::AmbilightFrameSource for Idle {
            fn capture_frame(
                &mut self,
            ) -> Result<std::sync::Arc<super::CapturedFrame>, super::AmbilightCaptureError>
            {
                Err(super::AmbilightCaptureError::FrameUnavailable)
            }
        }

        assert!(!super::capture_active());
        let first = super::Counted::new(Box::new(Idle));
        let second = super::Counted::new(Box::new(Idle));
        drop(first);
        assert!(super::capture_active());
        drop(second);
        assert!(!super::capture_active());
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    #[test]
    fn live_source_factory_returns_coded_unsupported_error_on_unsupported_platform() {
        let error = match create_live_frame_source(None) {
            Ok(_) => panic!("unsupported platform live source should fail"),
            Err(error) => error,
        };

        assert_eq!(
            error,
            AmbilightCaptureError::InvalidFrame("AMBILIGHT_CAPTURE_UNSUPPORTED_PLATFORM")
        );
        assert_eq!(
            error.as_reason(),
            "AMBILIGHT_CAPTURE_UNSUPPORTED_PLATFORM".to_string()
        );
    }

    // ------------------------------------------------------------------
    // CPU-side downscale shared by the Windows and Linux capture paths
    // ------------------------------------------------------------------

    /// Synthetic tightly-packed 4-byte-per-pixel buffer where every pixel
    /// encodes its own `(x, y)` so a subsample can be checked positionally.
    fn coordinate_buffer(width: usize, height: usize) -> Vec<u8> {
        let mut buffer = Vec::with_capacity(width * height * 4);
        for y in 0..height {
            for x in 0..width {
                buffer.extend_from_slice(&[x as u8, y as u8, 200, 255]);
            }
        }
        buffer
    }

    #[test]
    fn downscale_stride_clamps_to_one_for_displays_under_the_cap() {
        assert_eq!(downscale_stride(640, 480), 1);
        assert_eq!(downscale_stride(500, 400), 1);
        assert_eq!(downscale_stride(1024, 768), 1);
    }

    #[test]
    fn downscale_stride_scales_with_the_longest_edge() {
        assert_eq!(downscale_stride(3840, 2160), 6);
        assert_eq!(downscale_stride(2560, 1080), 4);
        // Portrait: the longest edge drives the stride regardless of axis.
        assert_eq!(downscale_stride(1080, 3840), 6);
    }

    #[test]
    fn downscaled_dimensions_round_up_on_non_square_frames() {
        assert_eq!(downscaled_dimensions(3840, 2160, 6), (640, 360));
        assert_eq!(downscaled_dimensions(2560, 1080, 4), (640, 270));
        // 2000 / 3 and 700 / 3 both have remainders — neither may truncate,
        // or the reported dimensions stop matching the emitted pixel count.
        assert_eq!(downscaled_dimensions(2000, 700, 3), (667, 234));
        assert_eq!(downscaled_dimensions(1024, 768, 1), (1024, 768));
    }

    #[test]
    fn subsample_at_stride_one_only_drops_the_alpha_byte() {
        let width = 5;
        let height = 3;
        let buffer = coordinate_buffer(width, height);

        let pixels = subsample_rgb(&buffer, width, height, 1);

        assert_eq!(pixels.len(), width * height);
        assert_eq!(pixels[0], [0, 0, 200]);
        assert_eq!(pixels[width * height - 1], [4, 2, 200]);
    }

    #[test]
    fn subsample_keeps_every_stride_th_pixel_on_both_axes() {
        let width = 8;
        let height = 4;
        let buffer = coordinate_buffer(width, height);

        let pixels = subsample_rgb(&buffer, width, height, 2);

        let (dst_w, dst_h) = downscaled_dimensions(width as u32, height as u32, 2);
        assert_eq!((dst_w, dst_h), (4, 2));
        assert_eq!(pixels.len(), (dst_w * dst_h) as usize);
        let sampled: Vec<[u8; 2]> = pixels.iter().map(|p| [p[0], p[1]]).collect();
        assert_eq!(
            sampled,
            vec![
                [0, 0],
                [2, 0],
                [4, 0],
                [6, 0],
                [0, 2],
                [2, 2],
                [4, 2],
                [6, 2],
            ]
        );
    }

    #[test]
    fn subsample_pixel_count_matches_the_reported_dimensions_when_rounding_up() {
        // 7 and 5 are both indivisible by 3, so a truncating dst_w/dst_h
        // would leave the frame narrower than the pixels it carries and
        // every downstream row index would slip.
        let width = 7;
        let height = 5;
        let stride = 3;
        let buffer = coordinate_buffer(width, height);

        let pixels = subsample_rgb(&buffer, width, height, stride);
        let (dst_w, dst_h) = downscaled_dimensions(width as u32, height as u32, stride);

        assert_eq!((dst_w, dst_h), (3, 2));
        assert_eq!(pixels.len(), (dst_w * dst_h) as usize);
    }

    #[test]
    fn a_4k_frame_collapses_below_the_capture_cap() {
        let (dst_w, dst_h) = downscaled_dimensions(3840, 2160, downscale_stride(3840, 2160));
        assert!(dst_w.max(dst_h) <= MAX_CAPTURE_DIM);
    }

    // ------------------------------------------------------------------
    // select_display_index — display selection helper
    // ------------------------------------------------------------------

    fn sample_candidates() -> Vec<DisplayCandidate> {
        vec![
            DisplayCandidate {
                id: "secondary:1920:0".to_string(),
                is_primary: false,
            },
            DisplayCandidate {
                id: "primary:0:0".to_string(),
                is_primary: true,
            },
            DisplayCandidate {
                id: "third:-1920:0".to_string(),
                is_primary: false,
            },
        ]
    }

    #[test]
    fn select_display_index_returns_none_when_no_candidates() {
        assert_eq!(select_display_index(Some("anything"), &[]), None);
        assert_eq!(select_display_index(None, &[]), None);
    }

    #[test]
    fn select_display_index_falls_back_to_primary_when_hint_absent() {
        let candidates = sample_candidates();
        let index = select_display_index(None, &candidates).expect("candidate expected");
        assert_eq!(candidates[index].id, "primary:0:0");
        assert!(candidates[index].is_primary);
    }

    #[test]
    fn select_display_index_falls_back_to_primary_when_hint_unknown() {
        // Simulates the unplugged / replugged monitor case: the persisted
        // id no longer resolves to any enumerated candidate.
        let candidates = sample_candidates();
        let index = select_display_index(Some("removed-monitor:9999:9999"), &candidates)
            .expect("candidate expected");
        assert!(candidates[index].is_primary);
        assert_eq!(candidates[index].id, "primary:0:0");
    }

    #[test]
    fn select_display_index_matches_exact_id_when_hint_present() {
        let candidates = sample_candidates();
        let index = select_display_index(Some("secondary:1920:0"), &candidates)
            .expect("candidate expected");
        assert_eq!(candidates[index].id, "secondary:1920:0");
        assert!(!candidates[index].is_primary);
    }

    #[test]
    fn select_display_index_ignores_blank_or_whitespace_hint() {
        let candidates = sample_candidates();
        let index = select_display_index(Some("   "), &candidates).expect("candidate expected");
        assert!(candidates[index].is_primary);
    }

    #[test]
    fn select_display_index_falls_back_to_first_when_no_primary_flagged() {
        let candidates = vec![
            DisplayCandidate {
                id: "a".to_string(),
                is_primary: false,
            },
            DisplayCandidate {
                id: "b".to_string(),
                is_primary: false,
            },
        ];
        let index = select_display_index(Some("missing"), &candidates).expect("candidate expected");
        assert_eq!(candidates[index].id, "a");
    }

    // ── Black-border detection ──────────────────────────────────────────────

    use super::{detect_black_borders, BlackBorderInsets, CapturedFrame, BLACK_BORDER_THRESHOLD};

    const W: u32 = 640;
    const H: u32 = 360;
    /// A 2.39:1 film on a 16:9 frame: 46 rows of bar above and below.
    const BAR: u32 = 46;

    fn frame(paint: impl Fn(u32, u32) -> [u8; 3]) -> CapturedFrame {
        frame_sized(W, H, paint)
    }

    fn frame_sized(w: u32, h: u32, paint: impl Fn(u32, u32) -> [u8; 3]) -> CapturedFrame {
        let pixels = (0..h)
            .flat_map(|y| (0..w).map(move |x| (x, y)))
            .map(|(x, y)| paint(x, y))
            .collect();
        CapturedFrame::new(w, h, pixels)
    }

    /// A busy picture: bright everywhere, varied enough to never read as bar.
    fn picture(x: u32, y: u32) -> [u8; 3] {
        [80 + (x % 120) as u8, 90 + (y % 100) as u8, 120]
    }

    fn letterboxed(bar: [u8; 3]) -> impl Fn(u32, u32) -> [u8; 3] {
        move |x, y| {
            if !(BAR..H - BAR).contains(&y) {
                bar
            } else {
                picture(x, y)
            }
        }
    }

    fn rows_cropped(insets: &BlackBorderInsets) -> (usize, usize) {
        let (rows, _) = insets.content_bounds(W as usize, H as usize);
        (rows.start, H as usize - rows.end)
    }

    fn detect(frame: &CapturedFrame) -> Option<BlackBorderInsets> {
        detect_black_borders(frame, BLACK_BORDER_THRESHOLD)
    }

    /// The crop lands on the bars, never more than one scan step into the picture.
    fn assert_crops_the_bars(insets: &BlackBorderInsets) {
        let (top, bottom) = rows_cropped(insets);
        for crop in [top, bottom] {
            assert!(
                (BAR as usize..BAR as usize + 8).contains(&crop),
                "crop {crop} rows, bars {BAR}"
            );
        }
        assert_eq!(insets.left, 0.0);
        assert_eq!(insets.right, 0.0);
    }

    #[test]
    fn a_letterboxed_film_is_cropped_to_its_picture() {
        assert_crops_the_bars(&detect(&frame(letterboxed([0, 0, 0]))).unwrap());
    }

    #[test]
    fn a_picture_to_every_edge_has_no_bars() {
        assert_eq!(detect(&frame(picture)), Some(BlackBorderInsets::default()));
    }

    // A fade or a cut through black says nothing about the bars: the caller keeps its crop.
    #[test]
    fn a_black_frame_measures_nothing() {
        assert_eq!(detect(&frame(|_, _| [0, 0, 0])), None);
        assert_eq!(detect(&frame(|_, _| [12, 12, 12])), None);
    }

    // Limited-range video draws its black at 16, above the true-black threshold.
    #[test]
    fn grey_bars_from_limited_range_video_are_bars() {
        assert_crops_the_bars(&detect(&frame(letterboxed([16, 16, 16]))).unwrap());
    }

    #[test]
    fn a_stray_bright_pixel_in_a_bar_is_not_picture() {
        let film = letterboxed([0, 0, 0]);
        let insets = detect(&frame(|x, y| {
            if (x, y) == (320, 8) {
                [255, 255, 255]
            } else {
                film(x, y)
            }
        }))
        .unwrap();
        assert_crops_the_bars(&insets);
    }

    #[test]
    fn subtitles_over_the_bottom_bar_keep_the_crop() {
        let film = letterboxed([0, 0, 0]);
        let insets = detect(&frame(|x, y| {
            let text = (H - 30..H - 18).contains(&y) && (200..440).contains(&x) && x % 5 < 3;
            if text {
                [235, 235, 235]
            } else {
                film(x, y)
            }
        }))
        .unwrap();
        assert_crops_the_bars(&insets);
    }

    // Players centre the picture: a dark band on one side only is a dark shot, not a bar.
    #[test]
    fn a_dark_sky_on_a_full_frame_is_not_a_bar() {
        let insets = detect(&frame(|x, y| {
            if y < H * 3 / 10 {
                [4, 4, 8]
            } else {
                picture(x, y)
            }
        }))
        .unwrap();
        assert_eq!(insets, BlackBorderInsets::default());
    }

    #[test]
    fn a_dark_shot_inside_a_letterbox_is_not_cropped_with_the_bar() {
        let film = letterboxed([0, 0, 0]);
        let insets = detect(&frame(|x, y| {
            if (BAR..BAR + 40).contains(&y) {
                [3, 3, 6]
            } else {
                film(x, y)
            }
        }))
        .unwrap();
        assert_crops_the_bars(&insets);
    }

    // A dark interface or a dim game is not bars, however even its edges look.
    #[test]
    fn a_dim_picture_is_not_cropped() {
        let dark_ui = |x: u32, y: u32| {
            if (120..520).contains(&x) && (140..220).contains(&y) {
                [200, 200, 200]
            } else {
                [30, 30, 30]
            }
        };
        assert_eq!(detect(&frame(dark_ui)), Some(BlackBorderInsets::default()));
        let dim_game = |x: u32, y: u32| {
            if (120..520).contains(&x) && (140..220).contains(&y) {
                [200, 200, 200]
            } else {
                [(x % 13) as u8 + 10, 10, (y % 11) as u8 + 10]
            }
        };
        assert_eq!(detect(&frame(dim_game)), Some(BlackBorderInsets::default()));
    }

    #[test]
    fn noisy_limited_range_bars_are_still_bars() {
        let film = letterboxed([0, 0, 0]);
        let insets = detect(&frame(|x, y| {
            if !(BAR..H - BAR).contains(&y) {
                [16 + (x % 5) as u8, 16, 16 + (y % 3) as u8]
            } else {
                film(x, y)
            }
        }))
        .unwrap();
        assert_crops_the_bars(&insets);
    }

    // A dark-topped picture with a lit object at its bottom: the object is picture, not a subtitle.
    #[test]
    fn a_centred_object_at_the_bottom_of_a_dark_shot_is_not_cropped() {
        let film = letterboxed([0, 0, 0]);
        let insets = detect(&frame(|x, y| {
            let dark_top = (BAR..BAR + 40).contains(&y);
            let dark_sides = (BAR + 40..H - BAR).contains(&y) && !(160..480).contains(&x);
            if dark_top || dark_sides {
                [3, 3, 6]
            } else {
                film(x, y)
            }
        }))
        .unwrap();
        let (top, bottom) = rows_cropped(&insets);
        assert_eq!(top, bottom);
        assert!(
            bottom <= BAR as usize + 8,
            "cropped {bottom} rows of a {BAR}-row bar"
        );
    }

    #[test]
    fn a_pillarboxed_picture_is_cropped_at_the_sides() {
        let side = 80;
        let insets = detect(&frame(|x, y| {
            if x < side || x >= W - side {
                [0, 0, 0]
            } else {
                picture(x, y)
            }
        }))
        .unwrap();
        let (_, cols) = insets.content_bounds(W as usize, H as usize);
        assert!(
            (side as usize..side as usize + 8).contains(&cols.start),
            "{cols:?}"
        );
        assert_eq!(cols.end, W as usize - cols.start);
        assert_eq!((insets.top, insets.bottom), (0.0, 0.0));
    }

    #[test]
    fn the_crop_never_takes_more_than_the_cap() {
        let insets = detect(&frame(|x, y| {
            if (170..190).contains(&y) {
                picture(x, y)
            } else {
                [0, 0, 0]
            }
        }))
        .unwrap();
        assert!(insets.top <= 0.40 && insets.bottom <= 0.40, "{insets:?}");
    }

    #[test]
    fn a_frame_smaller_than_a_scan_step_is_read_whole() {
        let insets = detect(&frame_sized(5, 3, |_, _| [200, 200, 200]));
        assert_eq!(insets, Some(BlackBorderInsets::default()));
        assert_eq!(detect(&frame_sized(0, 0, |_, _| [0, 0, 0])), None);
    }

    #[test]
    fn content_bounds_keep_every_row_the_insets_name() {
        for h in 1..400usize {
            for rows in 0..=(h * 2 / 5) {
                let insets = BlackBorderInsets {
                    top: rows as f32 / h as f32,
                    ..Default::default()
                };
                assert_eq!(
                    insets.content_bounds(4, h).0.start,
                    rows,
                    "h={h} rows={rows}"
                );
            }
        }
    }
}
