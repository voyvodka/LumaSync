//! The Effect mode: its wire shape (lenient to what a newer build writes), the
//! drawn frames, and the worker it runs on.

use serde_json::json;

use super::config::{
    normalize_mode_config, EffectColor, EffectDirection, EffectId, PaletteId, DEFAULT_EFFECT,
    DEFAULT_SOLID,
};
use super::effect_source::{loops_per_sec, render_effect};
use super::{EffectPayload, LightingModeConfig, LightingModeKind, SolidColorPayload};

#[test]
fn a_kind_this_build_does_not_know_reads_as_off() {
    let mode: LightingModeConfig =
        serde_json::from_value(json!({ "kind": "music", "solid": null })).expect("still reads");
    assert_eq!(mode.kind, LightingModeKind::Off);
}

#[test]
fn an_effect_this_build_does_not_know_reads_as_the_wave() {
    let mode: LightingModeConfig = serde_json::from_value(json!({
        "kind": "effect",
        "effect": { "id": "lightning", "speed": 0.2, "brightness": 0.5 }
    }))
    .expect("still reads");
    assert_eq!(mode.kind, LightingModeKind::Effect);
    let effect = mode.effect.expect("an effect");
    assert_eq!(effect.id, EffectId::Wave);
    assert_eq!(effect.speed, 0.2);
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
            size: Some(-3.0),
            duration_minutes: Some(900),
            colors: Some(vec![EffectColor { r: 1, g: 2, b: 3 }; 5]),
            ..DEFAULT_EFFECT
        }),
        ..LightingModeConfig::default()
    });
    let effect = mode.effect.expect("an effect payload");
    assert_eq!(effect.speed, 1.0);
    assert_eq!(effect.brightness, 1.0);
    assert_eq!(effect.size, Some(0.0));
    assert_eq!(effect.duration_minutes, Some(120));
    assert_eq!(effect.colors.map(|c| c.len()), Some(3));
    assert_eq!(mode.display_id, None);

    let bare = normalize_mode_config(LightingModeConfig {
        kind: LightingModeKind::Effect,
        ..LightingModeConfig::default()
    });
    assert_eq!(bare.effect.map(|effect| effect.id), Some(EffectId::Wave));
}

/// The three v1 effects were saved by dev builds; each reads as what it became.
#[test]
fn a_v1_effect_reads_as_its_v2_equivalent() {
    let read = |value| serde_json::from_value::<EffectPayload>(value).expect("reads");

    let rainbow = read(json!({ "id": "rainbow", "speed": 0.3, "brightness": 1 }));
    assert_eq!(
        (rainbow.id, rainbow.palette),
        (EffectId::Wave, Some(PaletteId::Rainbow))
    );

    let cycle = read(json!({ "id": "cycle", "speed": 0.3, "brightness": 1 }));
    assert_eq!(
        (cycle.id, cycle.palette),
        (EffectId::Cycle, Some(PaletteId::Rainbow))
    );

    let breathe = read(json!({ "id": "breathe", "color": { "r": 10, "g": 20, "b": 30 } }));
    assert_eq!(breathe.id, EffectId::Breathe);
    assert_eq!(breathe.palette, Some(PaletteId::Custom));
    assert_eq!(
        breathe.colors,
        Some(vec![EffectColor {
            r: 10,
            g: 20,
            b: 30
        }])
    );

    let bare_breathe = read(json!({ "id": "breathe" }));
    assert_eq!(
        bare_breathe.colors,
        Some(vec![EffectColor {
            r: 255,
            g: 176,
            b: 32
        }])
    );
}

/// A hand-edited file must not take the whole mode down with one bad field.
#[test]
fn a_bad_field_fails_soft_on_its_own() {
    let effect: EffectPayload = serde_json::from_value(json!({
        "id": "candle",
        "speed": "fast",
        "palette": "neon",
        "direction": 7,
        "colors": [{ "r": 300, "g": 12.7, "b": -4 }, "red", { "r": 1, "g": 2, "b": 3 }],
        "intensity": 2,
        "durationMinutes": "long"
    }))
    .expect("still reads");
    assert_eq!(effect.id, EffectId::Candle);
    assert_eq!(effect.speed, DEFAULT_EFFECT.speed);
    assert_eq!(effect.palette, None);
    assert_eq!(effect.direction, None);
    assert_eq!(
        effect.colors,
        Some(vec![
            EffectColor {
                r: 255,
                g: 12,
                b: 0
            },
            EffectColor { r: 1, g: 2, b: 3 }
        ])
    );
    assert_eq!(effect.intensity, Some(1.0));
    assert_eq!(effect.duration_minutes, None);
}

/// `lenient_enum!` reads tags it lists; `Serialize` writes what serde derives.
/// A tag spelt differently from the derive would read back as the default.
#[test]
fn every_variant_reads_back_what_it_writes() {
    fn round_trips<T: serde::Serialize + PartialEq + std::fmt::Debug + Copy>(
        tags: &[(&str, T)],
        from_tag: fn(&str) -> Option<T>,
    ) {
        for (tag, variant) in tags {
            let written = serde_json::to_value(variant).unwrap();
            assert_eq!(written, json!(tag), "{variant:?}");
            assert_eq!(from_tag(tag), Some(*variant));
        }
    }
    round_trips(LightingModeKind::TAGS, LightingModeKind::from_tag);
    round_trips(EffectId::TAGS, EffectId::from_tag);
    round_trips(PaletteId::TAGS, PaletteId::from_tag);
    round_trips(EffectDirection::TAGS, EffectDirection::from_tag);
}

#[test]
fn a_white_solid_takes_its_colour_from_the_temperature() {
    let mode = normalize_mode_config(LightingModeConfig {
        kind: LightingModeKind::Solid,
        solid: serde_json::from_value(json!({
            "r": 0, "g": 0, "b": 255, "brightness": 1, "kelvin": 99999
        }))
        .ok(),
        ..LightingModeConfig::default()
    });
    let solid = mode.solid.expect("a solid payload");
    assert_eq!(solid.kelvin, Some(6500));
    assert_eq!((solid.r, solid.g, solid.b), (255, 255, 255));

    let warm = SolidColorPayload {
        kelvin: Some(2000),
        ..DEFAULT_SOLID
    }
    .resolved();
    assert!(warm.r > warm.g && warm.g > warm.b, "{warm:?}");
}

/// A mode that never ran an effect echoes exactly as it did before effects.
#[test]
fn a_mode_without_an_effect_serialises_without_the_key() {
    let value = serde_json::to_value(LightingModeConfig::default()).unwrap();
    assert!(value.get("effect").is_none(), "{value}");
}

#[test]
fn a_faster_speed_is_a_shorter_loop_for_every_effect() {
    for id in [EffectId::Wave, EffectId::Breathe, EffectId::Cycle] {
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
        colors: Some(vec![EffectColor {
            r: 200,
            g: 100,
            b: 0,
        }]),
        ..DEFAULT_EFFECT
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
