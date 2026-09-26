//! What `apply_mode_change` refuses before it touches anything: an output name
//! it does not know, a calibration whose shape the encoders cannot trust, a
//! colour correction outside the ranges the settings panel offers. Refused
//! with `LIGHTING_MODE_INVALID_CONFIG` and the reason in `details`, so the
//! running mode is left as it was.

use std::ops::RangeInclusive;

use super::LightingModeConfig;
use crate::commands::led_output::ColorCorrectionConfig;

/// `GAMMA_RANGE` in `src/shared/contracts/device.ts`.
pub(crate) const GAMMA_RANGE: RangeInclusive<f32> = 1.0..=3.0;
/// `KELVIN_RANGE_K` in `src/shared/contracts/device.ts`.
pub(crate) const KELVIN_RANGE: RangeInclusive<u16> = 2000..=8000;
/// `SATURATION_RANGE` in `src/shared/contracts/device.ts`.
pub(crate) const SATURATION_RANGE: RangeInclusive<f32> = 0.0..=2.0;

pub(crate) fn check_color_correction(correction: &ColorCorrectionConfig) -> Result<(), String> {
    for (field, value) in [
        ("gammaR", correction.gamma_r),
        ("gammaG", correction.gamma_g),
        ("gammaB", correction.gamma_b),
    ] {
        if !GAMMA_RANGE.contains(&value) {
            return Err(format!(
                "colorCorrection.{field} {value} is outside {GAMMA_RANGE:?}"
            ));
        }
    }
    if !KELVIN_RANGE.contains(&correction.kelvin) {
        return Err(format!(
            "colorCorrection.kelvin {} is outside {KELVIN_RANGE:?}",
            correction.kelvin
        ));
    }
    if !SATURATION_RANGE.contains(&correction.saturation) {
        return Err(format!(
            "colorCorrection.saturation {} is outside {SATURATION_RANGE:?}",
            correction.saturation
        ));
    }
    Ok(())
}

fn clamp_or(value: f32, range: &RangeInclusive<f32>, fallback: f32) -> f32 {
    if value.is_finite() {
        value.clamp(*range.start(), *range.end())
    } else {
        fallback
    }
}

/// The saved correction as the frontend's `normalizeColorCorrection` reads it:
/// clamped into range, a non-number replaced by the default. Rust reads the
/// saved value itself now, so a value an older build let through must not
/// start refusing every mode after an update.
pub(crate) fn clamp_color_correction(correction: ColorCorrectionConfig) -> ColorCorrectionConfig {
    let default = ColorCorrectionConfig::default();
    ColorCorrectionConfig {
        gamma_r: clamp_or(correction.gamma_r, &GAMMA_RANGE, default.gamma_r),
        gamma_g: clamp_or(correction.gamma_g, &GAMMA_RANGE, default.gamma_g),
        gamma_b: clamp_or(correction.gamma_b, &GAMMA_RANGE, default.gamma_b),
        kelvin: correction
            .kelvin
            .clamp(*KELVIN_RANGE.start(), *KELVIN_RANGE.end()),
        saturation: clamp_or(correction.saturation, &SATURATION_RANGE, default.saturation),
    }
}

/// Every check a mode must pass before it may start.
pub(crate) fn check_mode_config(mode: &LightingModeConfig) -> Result<(), String> {
    if let Some(targets) = &mode.targets {
        if let Some(unknown) = targets
            .iter()
            .find(|t| t.as_str() != "usb" && t.as_str() != "hue")
        {
            return Err(format!("unknown output target {unknown:?}"));
        }
    }
    if let Some(calibration) = &mode.led_calibration {
        calibration
            .validate()
            .map_err(|reason| format!("ledCalibration: {reason}"))?;
    }
    if let Some(correction) = &mode.color_correction {
        check_color_correction(correction)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::led_calibration::{LedCalibrationConfig, LedSegmentCounts};
    use crate::commands::lighting_mode::LightingModeKind;

    fn calibration(top: u16, bottom: u16, bottom_missing: u16, total: u16) -> LedCalibrationConfig {
        LedCalibrationConfig {
            template_id: None,
            counts: LedSegmentCounts {
                top,
                right: 10,
                bottom,
                left: 10,
            },
            bottom_missing,
            corner_ownership: "horizontal".into(),
            visual_preset: "vivid".into(),
            start_anchor: "top-start".into(),
            start_local_index: None,
            direction: "cw".into(),
            total_leds: total,
        }
    }

    fn mode_with(calibration: Option<LedCalibrationConfig>) -> LightingModeConfig {
        LightingModeConfig {
            kind: LightingModeKind::Ambilight,
            led_calibration: calibration,
            ..LightingModeConfig::default()
        }
    }

    #[test]
    fn a_consistent_calibration_passes() {
        assert_eq!(
            check_mode_config(&mode_with(Some(calibration(20, 20, 4, 60)))),
            Ok(())
        );
    }

    #[test]
    fn counts_that_disagree_with_the_total_are_refused() {
        let reason = check_mode_config(&mode_with(Some(calibration(20, 20, 0, 59)))).unwrap_err();
        assert!(reason.contains("add up to 60"), "{reason}");
    }

    #[test]
    fn a_calibration_past_the_cap_is_refused_before_anything_is_sized() {
        let huge = calibration(u16::MAX, u16::MAX, 0, 0);
        let reason = huge.validate().unwrap_err();
        assert!(reason.contains("totalLeds"), "{reason}");
        let consistent_but_huge = LedCalibrationConfig {
            counts: LedSegmentCounts {
                top: 4000,
                right: 100,
                bottom: 0,
                left: 0,
            },
            total_leds: 4100,
            ..calibration(0, 0, 0, 0)
        };
        let reason = consistent_but_huge.validate().unwrap_err();
        assert!(reason.contains("4096"), "{reason}");
    }

    /// A wide stand under a narrow monitor is a real layout, and a file an
    /// older build saved with a wide gap must keep running after an update.
    #[test]
    fn a_gap_wider_than_the_bottom_edge_is_accepted() {
        assert_eq!(calibration(20, 4, 5, 44).validate(), Ok(()));
    }

    #[test]
    fn an_unknown_enum_string_is_refused() {
        let mut config = calibration(20, 20, 0, 60);
        config.direction = "sideways".into();
        let reason = config.validate().unwrap_err();
        assert!(reason.contains("direction"), "{reason}");
    }

    #[test]
    fn an_unknown_target_is_refused_rather_than_run_on_nothing() {
        let mode = LightingModeConfig {
            targets: Some(vec!["hdmi".into()]),
            ..mode_with(None)
        };
        let reason = check_mode_config(&mode).unwrap_err();
        assert!(reason.contains("hdmi"), "{reason}");
    }

    #[test]
    fn a_correction_outside_the_panel_ranges_is_refused_and_a_saved_one_is_clamped() {
        let wild = ColorCorrectionConfig {
            gamma_r: f32::NAN,
            gamma_g: 9.0,
            gamma_b: 0.1,
            kelvin: 12_000,
            saturation: -1.0,
        };
        assert!(check_color_correction(&wild).is_err());
        let clamped = clamp_color_correction(wild);
        assert_eq!(clamped.gamma_r, 2.2);
        assert_eq!(clamped.gamma_g, 3.0);
        assert_eq!(clamped.gamma_b, 1.0);
        assert_eq!(clamped.kelvin, 8000);
        assert_eq!(clamped.saturation, 0.0);
        assert_eq!(check_color_correction(&clamped), Ok(()));
    }
}
