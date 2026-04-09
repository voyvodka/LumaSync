#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CapturedFrame {
    pub width: u32,
    pub height: u32,
    pub pixels_rgb: Vec<[u8; 3]>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SamplingCalibration {
    pub led_count: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SampledLedFrame {
    pub colors: Vec<[u8; 3]>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AmbilightCaptureError {
    #[cfg_attr(
        not(any(test, target_os = "windows", target_os = "macos")),
        allow(dead_code)
    )]
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

use std::sync::Arc;

pub trait AmbilightFrameSource: Send {
    fn capture_frame(&mut self) -> Result<Arc<CapturedFrame>, AmbilightCaptureError>;
}

pub fn create_live_frame_source() -> Result<Box<dyn AmbilightFrameSource>, AmbilightCaptureError> {
    platform::create_live_frame_source()
}

pub struct StaticFrameSource {
    frame: CapturedFrame,
}

impl StaticFrameSource {
    pub fn new(frame: CapturedFrame) -> Self {
        Self { frame }
    }

    pub fn default_frame() -> CapturedFrame {
        CapturedFrame {
            width: 4,
            height: 1,
            pixels_rgb: vec![[18, 30, 44], [42, 60, 80], [96, 108, 120], [150, 162, 174]],
        }
    }
}

impl Default for StaticFrameSource {
    fn default() -> Self {
        Self::new(Self::default_frame())
    }
}

impl AmbilightFrameSource for StaticFrameSource {
    fn capture_frame(&mut self) -> Result<Arc<CapturedFrame>, AmbilightCaptureError> {
        Ok(Arc::new(self.frame.clone()))
    }
}

#[cfg(target_os = "windows")]
mod platform {
    use std::sync::{Arc, Mutex};

    use windows_capture::capture::{
        CaptureControl, GraphicsCaptureApiError, GraphicsCaptureApiHandler,
    };
    use windows_capture::frame::Frame;
    use windows_capture::graphics_capture_api::InternalCaptureControl;
    use windows_capture::monitor::Monitor;
    use windows_capture::settings::{
        ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
        MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
    };

    use super::{AmbilightCaptureError, AmbilightFrameSource, CapturedFrame};

    type SharedFrame = Arc<Mutex<Option<Arc<CapturedFrame>>>>;

    pub(super) fn create_live_frame_source(
    ) -> Result<Box<dyn AmbilightFrameSource>, AmbilightCaptureError> {
        let latest_frame = Arc::new(Mutex::new(None));
        let monitor = Monitor::primary().map_err(|_| {
            AmbilightCaptureError::InvalidFrame("AMBILIGHT_CAPTURE_MONITOR_NOT_FOUND")
        })?;
        let settings = Settings::new(
            monitor,
            CursorCaptureSettings::Default,
            DrawBorderSettings::Default,
            SecondaryWindowSettings::Default,
            MinimumUpdateIntervalSettings::Default,
            DirtyRegionSettings::Default,
            ColorFormat::Rgba8,
            Arc::clone(&latest_frame),
        );

        let capture_control =
            WindowsLiveCaptureHandler::start_free_threaded(settings).map_err(map_start_error)?;

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
            if let Some(capture_control) = self.capture_control.take() {
                let _ = capture_control.stop();
            }
        }
    }

    impl AmbilightFrameSource for WindowsLiveFrameSource {
        fn capture_frame(&mut self) -> Result<Arc<CapturedFrame>, AmbilightCaptureError> {
            let frame_guard = self.latest_frame.lock().map_err(|_| {
                AmbilightCaptureError::InvalidFrame("AMBILIGHT_CAPTURE_FRAME_LOCK_FAILED")
            })?;

            frame_guard
                .clone()
                .ok_or(AmbilightCaptureError::FrameUnavailable)
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
            let mut frame_buffer = frame
                .buffer()
                .map_err(|_| "AMBILIGHT_CAPTURE_FRAME_BUFFER_FAILED")?;
            let raw_pixels = frame_buffer
                .as_nopadding_buffer()
                .map_err(|_| "AMBILIGHT_CAPTURE_FRAME_BUFFER_FAILED")?;
            let expected_len = (width as usize)
                .saturating_mul(height as usize)
                .saturating_mul(4);

            if raw_pixels.len() < expected_len {
                return Err("AMBILIGHT_CAPTURE_PIXEL_BUFFER_INVALID");
            }

            let mut pixels_rgb =
                Vec::with_capacity((width as usize).saturating_mul(height as usize));
            for pixel in raw_pixels[..expected_len].chunks_exact(4) {
                pixels_rgb.push([pixel[0], pixel[1], pixel[2]]);
            }

            let mut frame_guard = self
                .latest_frame
                .lock()
                .map_err(|_| "AMBILIGHT_CAPTURE_FRAME_LOCK_FAILED")?;
            *frame_guard = Some(Arc::new(CapturedFrame {
                width,
                height,
                pixels_rgb,
            }));

            Ok(())
        }
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use std::sync::{Arc, Mutex};

    use screencapturekit::cv::CVPixelBufferLockFlags;
    use screencapturekit::prelude::*;

    use super::{AmbilightCaptureError, AmbilightFrameSource, CapturedFrame};

    type SharedFrame = Arc<Mutex<Option<Arc<CapturedFrame>>>>;

    pub(super) fn create_live_frame_source(
    ) -> Result<Box<dyn AmbilightFrameSource>, AmbilightCaptureError> {
        let content = SCShareableContent::get().map_err(|_| {
            AmbilightCaptureError::InvalidFrame("AMBILIGHT_CAPTURE_PERMISSION_DENIED")
        })?;

        let display = content
            .displays()
            .into_iter()
            .next()
            .ok_or(AmbilightCaptureError::InvalidFrame(
                "AMBILIGHT_CAPTURE_MONITOR_NOT_FOUND",
            ))?;

        let filter = SCContentFilter::create()
            .with_display(&display)
            .with_excluding_windows(&[])
            .build();

        // Downscale to ~640px max dimension for ambilight color sampling.
        // SCStream performs hardware-accelerated scaling on the GPU — zero extra CPU cost.
        // Full resolution (e.g. 2560x1600) wastes CPU on BGRA→RGB conversion,
        // frame cloning, and pixel iteration. ~640x400 is more than sufficient
        // for averaging colors in screen regions.
        let native_w = display.width() as u32;
        let native_h = display.height() as u32;
        const MAX_CAPTURE_DIM: u32 = 640;
        let (capture_width, capture_height) = if native_w.max(native_h) > MAX_CAPTURE_DIM {
            let scale = native_w.max(native_h) / MAX_CAPTURE_DIM;
            ((native_w / scale).max(1), (native_h / scale).max(1))
        } else {
            (native_w, native_h)
        };

        // 20 Hz = 50ms interval, matching Hue streaming constraint
        let frame_interval = CMTime::new(1, 20);

        let config = SCStreamConfiguration::new()
            .with_width(capture_width)
            .with_height(capture_height)
            .with_pixel_format(PixelFormat::BGRA)
            .with_shows_cursor(false)
            .with_minimum_frame_interval(&frame_interval);

        let latest_frame: SharedFrame = Arc::new(Mutex::new(None));
        let frame_writer = Arc::clone(&latest_frame);

        let mut stream = SCStream::new(&filter, &config);

        stream.add_output_handler(
            move |sample: CMSampleBuffer, of_type: SCStreamOutputType| {
                if of_type != SCStreamOutputType::Screen {
                    return;
                }

                let buffer = match sample.image_buffer() {
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
                let raw_data = guard.as_slice();

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

                if let Ok(mut frame_guard) = frame_writer.lock() {
                    *frame_guard = Some(Arc::new(CapturedFrame {
                        width,
                        height,
                        pixels_rgb,
                    }));
                }
            },
            SCStreamOutputType::Screen,
        );

        stream.start_capture().map_err(|_| {
            AmbilightCaptureError::InvalidFrame("AMBILIGHT_CAPTURE_SESSION_START_FAILED")
        })?;

        Ok(Box::new(MacOSLiveFrameSource {
            latest_frame,
            stream,
        }))
    }

    struct MacOSLiveFrameSource {
        latest_frame: SharedFrame,
        stream: SCStream,
    }

    impl Drop for MacOSLiveFrameSource {
        fn drop(&mut self) {
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
            let frame_guard = self.latest_frame.lock().map_err(|_| {
                AmbilightCaptureError::InvalidFrame("AMBILIGHT_CAPTURE_FRAME_LOCK_FAILED")
            })?;

            // Arc::clone is 8 bytes (refcount bump) vs full CapturedFrame clone (~768 KB).
            frame_guard
                .clone()
                .ok_or(AmbilightCaptureError::FrameUnavailable)
        }
    }

    // Safety: SCStream is created and owned; the Arc<Mutex<>> shared state is Send+Sync.
    // The closure handler is moved into SCStream which manages its own dispatch queue.
    unsafe impl Send for MacOSLiveFrameSource {}
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
mod platform {
    use super::{AmbilightCaptureError, AmbilightFrameSource};

    pub(super) fn create_live_frame_source(
    ) -> Result<Box<dyn AmbilightFrameSource>, AmbilightCaptureError> {
        Err(AmbilightCaptureError::InvalidFrame(
            "AMBILIGHT_CAPTURE_UNSUPPORTED_PLATFORM",
        ))
    }
}

/// Detected black border insets, expressed as fractions of the frame dimensions.
///
/// Each field is in [0.0, 0.5]. A zero value means no border was found on
/// that edge. Used by both the USB sampling path (frame crop) and the Hue
/// sampling path (region bounds adjustment).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct BlackBorderInsets {
    pub top: f32,
    pub bottom: f32,
    pub left: f32,
    pub right: f32,
}

impl BlackBorderInsets {
    /// Returns `true` when all insets are effectively zero (no border detected).
    pub fn is_zero(&self) -> bool {
        self.top < f32::EPSILON
            && self.bottom < f32::EPSILON
            && self.left < f32::EPSILON
            && self.right < f32::EPSILON
    }
}

const BORDER_SCAN_STEP: usize = 8;
const BORDER_MAX_INSET: f32 = 0.40;

fn row_has_content(pixels: &[[u8; 3]], w: usize, row: usize, threshold: u8) -> bool {
    for col in (0..w).step_by(BORDER_SCAN_STEP) {
        if let Some(pixel) = pixels.get(row * w + col) {
            if pixel[0].max(pixel[1]).max(pixel[2]) > threshold {
                return true;
            }
        }
    }
    false
}

fn col_has_content(pixels: &[[u8; 3]], w: usize, h: usize, col: usize, threshold: u8) -> bool {
    for row in (0..h).step_by(BORDER_SCAN_STEP) {
        if let Some(pixel) = pixels.get(row * w + col) {
            if pixel[0].max(pixel[1]).max(pixel[2]) > threshold {
                return true;
            }
        }
    }
    false
}

/// Detect letterbox / pillarbox black borders in `frame`.
///
/// Scans inward from each edge (every `BORDER_SCAN_STEP` pixels for speed)
/// until a pixel brighter than `threshold` is found. Returns the resulting
/// insets as fractions of the frame dimensions, capped at `BORDER_MAX_INSET`.
pub fn detect_black_borders(frame: &CapturedFrame, threshold: u8) -> BlackBorderInsets {
    let w = frame.width as usize;
    let h = frame.height as usize;
    if w == 0 || h == 0 || frame.pixels_rgb.is_empty() {
        return BlackBorderInsets::default();
    }

    let px = frame.pixels_rgb.as_slice();

    // Top
    let mut top_rows = 0usize;
    for row in (0..h).step_by(BORDER_SCAN_STEP) {
        if row_has_content(px, w, row, threshold) {
            top_rows = row;
            break;
        }
    }

    // Bottom
    let mut bottom_rows = 0usize;
    let mut row = h.saturating_sub(1);
    loop {
        if row_has_content(px, w, row, threshold) {
            bottom_rows = h.saturating_sub(row + 1);
            break;
        }
        if row < BORDER_SCAN_STEP {
            break;
        }
        row -= BORDER_SCAN_STEP;
    }

    // Left
    let mut left_cols = 0usize;
    for col in (0..w).step_by(BORDER_SCAN_STEP) {
        if col_has_content(px, w, h, col, threshold) {
            left_cols = col;
            break;
        }
    }

    // Right
    let mut right_cols = 0usize;
    let mut col = w.saturating_sub(1);
    loop {
        if col_has_content(px, w, h, col, threshold) {
            right_cols = w.saturating_sub(col + 1);
            break;
        }
        if col < BORDER_SCAN_STEP {
            break;
        }
        col -= BORDER_SCAN_STEP;
    }

    BlackBorderInsets {
        top: (top_rows as f32 / h as f32).min(BORDER_MAX_INSET),
        bottom: (bottom_rows as f32 / h as f32).min(BORDER_MAX_INSET),
        left: (left_cols as f32 / w as f32).min(BORDER_MAX_INSET),
        right: (right_cols as f32 / w as f32).min(BORDER_MAX_INSET),
    }
}

/// Return a new `CapturedFrame` that contains only the non-black-border region.
///
/// When `insets.is_zero()` this clones the original frame unchanged.
/// Kept for potential future use; the hot path now uses bounds-based sampling instead.
#[allow(dead_code)]
pub fn crop_frame_to_content(frame: &CapturedFrame, insets: &BlackBorderInsets) -> CapturedFrame {
    if insets.is_zero() {
        return frame.clone();
    }
    let w = frame.width as usize;
    let h = frame.height as usize;
    let top = (h as f32 * insets.top) as usize;
    let bottom = h.saturating_sub((h as f32 * insets.bottom) as usize);
    let left = (w as f32 * insets.left) as usize;
    let right = w.saturating_sub((w as f32 * insets.right) as usize);
    if top >= bottom || left >= right {
        return frame.clone();
    }
    let new_h = bottom - top;
    let new_w = right - left;
    let mut pixels_rgb = Vec::with_capacity(new_h * new_w);
    for row in top..bottom {
        for col in left..right {
            if let Some(pixel) = frame.pixels_rgb.get(row * w + col) {
                pixels_rgb.push(*pixel);
            }
        }
    }
    CapturedFrame { width: new_w as u32, height: new_h as u32, pixels_rgb }
}

pub fn sample_led_frame(
    frame: &CapturedFrame,
    calibration: &SamplingCalibration,
) -> Result<SampledLedFrame, AmbilightCaptureError> {
    if frame.width == 0 || frame.height == 0 {
        return Err(AmbilightCaptureError::InvalidFrame(
            "FRAME_DIMENSIONS_INVALID",
        ));
    }

    let expected_pixels = (frame.width as usize).saturating_mul(frame.height as usize);
    if frame.pixels_rgb.len() != expected_pixels {
        return Err(AmbilightCaptureError::InvalidFrame(
            "FRAME_PIXEL_COUNT_MISMATCH",
        ));
    }

    if calibration.led_count == 0 {
        return Err(AmbilightCaptureError::InvalidFrame("LED_COUNT_INVALID"));
    }

    let mut colors = Vec::with_capacity(calibration.led_count);
    for led_index in 0..calibration.led_count {
        let source_index = led_index % frame.pixels_rgb.len();
        colors.push(frame.pixels_rgb[source_index]);
    }

    Ok(SampledLedFrame { colors })
}

#[cfg(test)]
mod tests {
    use super::{
        create_live_frame_source, sample_led_frame, AmbilightCaptureError, AmbilightFrameSource,
        CapturedFrame, SamplingCalibration,
    };

    struct SingleFrameSource {
        frame: Option<CapturedFrame>,
    }

    impl AmbilightFrameSource for SingleFrameSource {
        fn capture_frame(&mut self) -> Result<Arc<CapturedFrame>, AmbilightCaptureError> {
            self.frame
                .take()
                .map(Arc::new)
                .ok_or(AmbilightCaptureError::FrameUnavailable)
        }
    }

    #[test]
    fn capture_and_sampler_produce_deterministic_led_rgb_list() {
        let mut source = SingleFrameSource {
            frame: Some(CapturedFrame {
                width: 2,
                height: 2,
                pixels_rgb: vec![[10, 20, 30], [40, 50, 60], [70, 80, 90], [15, 25, 35]],
            }),
        };

        let frame = source.capture_frame().expect("frame should be available");
        let sampled = sample_led_frame(&frame, &SamplingCalibration { led_count: 4 })
            .expect("sampling should succeed");

        assert_eq!(
            sampled.colors,
            vec![[10, 20, 30], [40, 50, 60], [70, 80, 90], [15, 25, 35]]
        );
    }

    #[test]
    fn invalid_or_missing_frame_returns_coded_error() {
        let mut source = SingleFrameSource { frame: None };
        let capture_error = source.capture_frame().expect_err("capture should fail");
        assert_eq!(capture_error, AmbilightCaptureError::FrameUnavailable);

        let invalid_frame = CapturedFrame {
            width: 0,
            height: 2,
            pixels_rgb: vec![[1, 2, 3]],
        };
        let sample_error = sample_led_frame(&invalid_frame, &SamplingCalibration { led_count: 2 })
            .expect_err("sampling should reject invalid frame");

        assert_eq!(
            sample_error,
            AmbilightCaptureError::InvalidFrame("FRAME_DIMENSIONS_INVALID")
        );
    }

    #[test]
    fn sampler_uses_calibration_led_count_without_magic_fallback() {
        let frame = CapturedFrame {
            width: 4,
            height: 1,
            pixels_rgb: vec![[5, 5, 5], [10, 10, 10], [15, 15, 15], [20, 20, 20]],
        };

        let sampled = sample_led_frame(&frame, &SamplingCalibration { led_count: 6 })
            .expect("sampling should succeed");

        assert_eq!(sampled.colors.len(), 6);
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    #[test]
    fn live_source_factory_returns_coded_unsupported_error_on_unsupported_platform() {
        let error = match create_live_frame_source() {
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
}
