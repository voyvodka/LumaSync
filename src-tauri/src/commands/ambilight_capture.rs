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

pub trait AmbilightFrameSource: Send {
    fn capture_frame(&mut self) -> Result<CapturedFrame, AmbilightCaptureError>;
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
        sample_led_frame, AmbilightCaptureError, AmbilightFrameSource, CapturedFrame,
        SamplingCalibration,
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
}
