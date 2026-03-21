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

pub trait AmbilightFrameSource: Send {
    fn capture_frame(&mut self) -> Result<CapturedFrame, AmbilightCaptureError>;
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
    fn capture_frame(&mut self) -> Result<CapturedFrame, AmbilightCaptureError> {
        Ok(self.frame.clone())
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

    type SharedFrame = Arc<Mutex<Option<CapturedFrame>>>;

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
        fn capture_frame(&mut self) -> Result<CapturedFrame, AmbilightCaptureError> {
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
            *frame_guard = Some(CapturedFrame {
                width,
                height,
                pixels_rgb,
            });

            Ok(())
        }
    }
}

#[cfg(not(target_os = "windows"))]
mod platform {
    use super::{AmbilightCaptureError, AmbilightFrameSource};

    pub(super) fn create_live_frame_source(
    ) -> Result<Box<dyn AmbilightFrameSource>, AmbilightCaptureError> {
        Err(AmbilightCaptureError::InvalidFrame(
            "AMBILIGHT_CAPTURE_UNSUPPORTED_PLATFORM",
        ))
    }
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
        fn capture_frame(&mut self) -> Result<CapturedFrame, AmbilightCaptureError> {
            self.frame
                .take()
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

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn live_source_factory_returns_coded_unsupported_error_on_non_windows() {
        let error = match create_live_frame_source() {
            Ok(_) => panic!("non-windows live source should fail"),
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
