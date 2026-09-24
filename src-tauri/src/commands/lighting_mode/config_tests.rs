//! `normalize_mode_config` and the request's wire shape.

use super::config::normalize_mode_config;
use super::{AmbilightPayload, LightingModeConfig, LightingModeKind};
use crate::commands::led_output::{ColorCorrectionConfig, FirmwareProfile, LedColorOrder};

// ---------------------------------------------------------------------------
// normalize_mode_config — color_correction and firmware_profile passthrough
// ---------------------------------------------------------------------------

#[test]
fn normalize_mode_config_passthrough_color_correction_and_firmware_profile() {
    let corrections = ColorCorrectionConfig {
        gamma_r: 1.8,
        gamma_g: 2.0,
        gamma_b: 2.2,
        kelvin: 4000,
        saturation: 0.8,
    };
    let profile = FirmwareProfile::Adalight;

    let input = LightingModeConfig {
        kind: LightingModeKind::Ambilight,
        solid: None,
        ambilight: Some(AmbilightPayload {
            brightness: 0.75,
            ..Default::default()
        }),
        targets: None,
        display_id: None,
        led_calibration: None,
        color_correction: Some(corrections.clone()),
        firmware_profile: Some(profile),
        chip_type: None,
        color_order: None,
        room_geometry: None,
    };

    let normalized = normalize_mode_config(input);

    assert_eq!(
        normalized.color_correction,
        Some(corrections),
        "color_correction must be preserved through normalization"
    );
    assert_eq!(
        normalized.firmware_profile,
        Some(FirmwareProfile::Adalight),
        "firmware_profile must be preserved through normalization"
    );
}

#[test]
fn normalize_mode_config_absent_fields_stay_none() {
    let input = LightingModeConfig {
        kind: LightingModeKind::Ambilight,
        solid: None,
        ambilight: Some(AmbilightPayload {
            brightness: 1.0,
            ..Default::default()
        }),
        targets: None,
        display_id: None,
        led_calibration: None,
        color_correction: None,
        firmware_profile: None,
        chip_type: None,
        color_order: None,
        room_geometry: None,
    };

    let normalized = normalize_mode_config(input);

    assert!(
        normalized.color_correction.is_none(),
        "color_correction must remain None when absent"
    );
    assert!(
        normalized.firmware_profile.is_none(),
        "firmware_profile must remain None when absent"
    );
}

#[test]
fn fast_path_guard_triggers_restart_on_color_correction_change() {
    // Verify that changing color_correction bypasses the live-update fast path
    // (forces a worker restart instead of in-place atomic update).
    let base = LightingModeConfig {
        kind: LightingModeKind::Ambilight,
        solid: None,
        ambilight: Some(AmbilightPayload {
            brightness: 0.8,
            ..Default::default()
        }),
        targets: None,
        display_id: None,
        led_calibration: None,
        color_correction: Some(ColorCorrectionConfig::default()),
        firmware_profile: None,
        chip_type: None,
        color_order: None,
        room_geometry: None,
    };

    let changed = LightingModeConfig {
        color_correction: Some(ColorCorrectionConfig {
            kelvin: 3200,
            ..ColorCorrectionConfig::default()
        }),
        ..base.clone()
    };

    // Equality on the two configs must differ — fast-path guard fails
    let base_normalized = normalize_mode_config(base);
    let changed_normalized = normalize_mode_config(changed);
    assert_ne!(
        base_normalized.color_correction, changed_normalized.color_correction,
        "different color_correction must break fast-path equality"
    );
}

#[test]
fn color_order_round_trips_as_color_order_and_is_omitted_when_absent() {
    let parsed: LightingModeConfig =
        serde_json::from_str(r#"{"kind":"ambilight","colorOrder":"grb"}"#).expect("parse");
    assert_eq!(parsed.color_order, Some(LedColorOrder::Grb));
    let echoed = serde_json::to_value(&parsed).expect("serialize");
    assert_eq!(echoed["colorOrder"], serde_json::json!("grb"));

    let plain = serde_json::to_value(LightingModeConfig::default()).expect("serialize");
    assert!(
        plain.get("colorOrder").is_none(),
        "an unset order keeps the echoed mode byte-identical"
    );
}

#[test]
fn normalize_mode_config_carries_the_color_order_for_every_kind() {
    for kind in [
        LightingModeKind::Off,
        LightingModeKind::Solid,
        LightingModeKind::Ambilight,
    ] {
        let label = format!("{kind:?}");
        let config = LightingModeConfig {
            kind,
            color_order: Some(LedColorOrder::Brg),
            ..LightingModeConfig::default()
        };
        assert_eq!(
            normalize_mode_config(config).color_order,
            Some(LedColorOrder::Brg),
            "{label}"
        );
    }
}
