//! How a smoothing preset resolves into the live alpha a worker reads.

use super::config::normalize_mode_config;
use super::{AmbilightPayload, LightingModeConfig, LightingModeKind};

// ---------------------------------------------------------------------------
// LightingSmoothingPreset — coefficient mapping and backward compat
// ---------------------------------------------------------------------------

#[test]
fn lighting_smoothing_preset_coefficient_mapping() {
    use crate::commands::hue_intensity::LightingSmoothingPreset;
    assert_eq!(LightingSmoothingPreset::Subtle.coefficient(), 0.15);
    assert_eq!(LightingSmoothingPreset::Moderate.coefficient(), 0.35);
    assert_eq!(LightingSmoothingPreset::Intense.coefficient(), 0.60);
}

#[test]
fn lighting_smoothing_preset_takes_priority_over_smoothing_alpha() {
    use crate::commands::hue_intensity::LightingSmoothingPreset;
    // When lighting_smoothing_preset is set, the live alpha must equal
    // the preset coefficient, not the raw smoothing_alpha slider value.
    let live = super::live::AmbilightLiveSettings::new(1.0, false, 0.99, 1.0);
    live.update(
        1.0,
        false,
        0.99, // raw slider — should be overridden
        1.0,
        Some(LightingSmoothingPreset::Subtle), // preset wins
    );
    let alpha = live.read_smoothing_alpha();
    assert!(
        (alpha - 0.15).abs() < 1e-5,
        "preset Subtle must override slider; expected 0.15, got {alpha}"
    );
}

#[test]
fn smoothing_alpha_slider_used_as_fallback_when_no_preset() {
    // Without a preset, raw smoothing_alpha must be applied directly.
    let live = super::live::AmbilightLiveSettings::new(1.0, false, 0.70, 1.0);
    live.update(1.0, false, 0.70, 1.0, None);
    let alpha = live.read_smoothing_alpha();
    assert!(
        (alpha - 0.70).abs() < 1e-5,
        "no-preset path must use raw slider; expected 0.70, got {alpha}"
    );
}

#[test]
fn hue_intensity_preset_backward_compat_coerced_to_smoothing_preset() {
    use crate::commands::hue_intensity::{HueIntensityPreset, LightingSmoothingPreset};
    // HueIntensityPreset is a type alias — the same values must resolve
    // identically when used through the lighting_smoothing_preset path.
    let via_alias: LightingSmoothingPreset = HueIntensityPreset::Intense;
    assert_eq!(via_alias, LightingSmoothingPreset::Intense);
    assert_eq!(via_alias.coefficient(), 0.60);
}

#[test]
fn lighting_smoothing_preset_field_propagates_through_normalize() {
    use crate::commands::hue_intensity::LightingSmoothingPreset;
    // lighting_smoothing_preset on an incoming payload must survive
    // normalize_mode_config unchanged.
    let config = LightingModeConfig {
        kind: LightingModeKind::Ambilight,
        ambilight: Some(AmbilightPayload {
            brightness: 0.8,
            lighting_smoothing_preset: Some(LightingSmoothingPreset::Intense),
            ..Default::default()
        }),
        ..Default::default()
    };
    let normalized = normalize_mode_config(config);
    assert_eq!(
        normalized
            .ambilight
            .as_ref()
            .and_then(|a| a.lighting_smoothing_preset),
        Some(LightingSmoothingPreset::Intense),
        "lighting_smoothing_preset must survive normalize_mode_config"
    );
}
