//! The Effect mode: its wire shape (lenient to what a newer build writes), the
//! drawn frames, and the worker it runs on.

use serde_json::json;

use super::config::{normalize_mode_config, EffectColor, EffectId, DEFAULT_EFFECT};
use super::effect_source::{loops_per_sec, render_effect};
use super::{EffectPayload, LightingModeConfig, LightingModeKind};

#[test]
fn a_kind_this_build_does_not_know_reads_as_off() {
    let mode: LightingModeConfig =
        serde_json::from_value(json!({ "kind": "music", "solid": null })).expect("still reads");
    assert_eq!(mode.kind, LightingModeKind::Off);
}

#[test]
fn an_effect_this_build_does_not_know_reads_as_the_rainbow() {
    let mode: LightingModeConfig = serde_json::from_value(json!({
        "kind": "effect",
        "effect": { "id": "fire", "speed": 0.2, "brightness": 0.5 }
    }))
    .expect("still reads");
    assert_eq!(mode.kind, LightingModeKind::Effect);
    assert_eq!(mode.effect.map(|effect| effect.id), Some(EffectId::Rainbow));
}

#[test]
fn an_effect_is_normalised_into_range_and_captures_no_display() {
    let mode = normalize_mode_config(LightingModeConfig {
        kind: LightingModeKind::Effect,
        display_id: Some("display-2".into()),
        effect: Some(EffectPayload {
            id: EffectId::Breathe,
            speed: 4.0,
            brightness: f32::NAN,
            color: None,
        }),
        ..LightingModeConfig::default()
    });
    let effect = mode.effect.expect("an effect payload");
    assert_eq!(effect.speed, 1.0);
    assert_eq!(effect.brightness, 1.0);
    assert_eq!(mode.display_id, None);

    let bare = normalize_mode_config(LightingModeConfig {
        kind: LightingModeKind::Effect,
        ..LightingModeConfig::default()
    });
    assert_eq!(bare.effect.map(|effect| effect.id), Some(EffectId::Rainbow));
}

/// A mode that never ran an effect echoes exactly as it did before effects.
#[test]
fn a_mode_without_an_effect_serialises_without_the_key() {
    let value = serde_json::to_value(LightingModeConfig::default()).unwrap();
    assert!(value.get("effect").is_none(), "{value}");
}

#[test]
fn a_faster_speed_is_a_shorter_loop_for_every_effect() {
    for id in [EffectId::Rainbow, EffectId::Breathe, EffectId::Cycle] {
        let rates: Vec<f32> = [0.0, 0.25, 0.5, 0.75, 1.0]
            .iter()
            .map(|speed| loops_per_sec(id, *speed))
            .collect();
        assert!(
            rates.windows(2).all(|pair| pair[0] < pair[1]),
            "{id:?}: {rates:?}"
        );
    }
}

/// The bottom of a breath is dim, not dark: dark reads as "off".
#[test]
fn a_breath_goes_from_a_dim_floor_to_its_full_colour() {
    let effect = EffectPayload {
        id: EffectId::Breathe,
        speed: 0.5,
        brightness: 1.0,
        color: Some(EffectColor {
            r: 200,
            g: 100,
            b: 0,
        }),
    };
    let low = render_effect(&effect, 0.0, 4, 2)[0];
    let high = render_effect(&effect, 0.5, 4, 2)[0];
    assert_eq!(high, [200, 100, 0]);
    assert!(low[0] > 0 && low[0] < 40, "{low:?}");
}

#[test]
fn the_cycle_moves_through_hues_over_its_loop() {
    let effect = EffectPayload {
        id: EffectId::Cycle,
        ..DEFAULT_EFFECT
    };
    let start = render_effect(&effect, 0.0, 2, 2)[0];
    let third = render_effect(&effect, 1.0 / 3.0, 2, 2)[0];
    assert_ne!(start, third);
}
