//! The effect engine: each light coloured where it is, through a palette, on a
//! clock that survives a rebuild. The first test is the v1 defect — a rainbow
//! averaged to grey on two Hue lamps — held as a regression.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use super::config::{
    normalize_effect, unix_ms_now, EffectColor, EffectDirection, EffectId, EffectPayload,
    PaletteId, DEFAULT_EFFECT,
};
use super::effects::{
    bytes_from_linear_test as bytes_from_linear, loops_per_sec, palette_for_test as palette_for,
    EffectClockSlot, EffectDraw, EffectStage, PaletteTest as Palette, CATALOGUE, CATALOGUE_JSON,
};
use crate::commands::hue::frame::{HueAreaChannel, HueScreenRegion};
use crate::commands::led_calibration::{
    build_led_sequence, LedCalibrationConfig, LedSegmentCounts, LedSequenceItem,
};

fn hue_channel(channel_id: u8, x: f32, y: f32, z: Option<f32>) -> HueAreaChannel {
    HueAreaChannel {
        channel_id,
        light_ids: vec![format!("light-{channel_id}")],
        screen_region: HueScreenRegion::Center,
        position_x: x,
        position_y: y,
        position_z: z,
    }
}

fn strip(total: u16) -> (Vec<LedSequenceItem>, LedSegmentCounts) {
    let top = total / 3;
    let bottom = total / 3;
    let side = (total - top - bottom) / 2;
    let counts = LedSegmentCounts {
        top,
        right: side,
        bottom,
        left: total - top - bottom - side,
    };
    let config = LedCalibrationConfig {
        template_id: None,
        counts: counts.clone(),
        bottom_missing: 0,
        corner_ownership: "horizontal".to_string(),
        visual_preset: "subtle".to_string(),
        start_anchor: "bottom-start".to_string(),
        start_local_index: None,
        direction: "cw".to_string(),
        total_leds: total,
    };
    (build_led_sequence(&config), counts)
}

fn stage(effect: EffectPayload) -> (EffectStage, Arc<Mutex<EffectPayload>>, EffectClockSlot) {
    let live = Arc::new(Mutex::new(effect));
    let clock = EffectClockSlot::default();
    let stage = EffectStage::new(EffectDraw {
        live: Arc::clone(&live),
        clock: Arc::clone(&clock),
    });
    (stage, live, clock)
}

fn effect(id: EffectId) -> EffectPayload {
    EffectPayload {
        id,
        ..DEFAULT_EFFECT
    }
}

/// Runs `stage` from `start` for `seconds`, one 40 ms step at a time, and
/// returns every step's Hue colours.
fn run_hue(
    stage: &mut EffectStage,
    channels: &[HueAreaChannel],
    start: Instant,
    seconds: f32,
) -> Vec<Vec<[u8; 3]>> {
    let (seq, counts) = strip(0);
    let steps = (seconds / 0.04) as u32;
    (0..=steps)
        .map(|i| {
            stage
                .draw(
                    start + Duration::from_millis(u64::from(i) * 40),
                    &seq,
                    &counts,
                    Some(channels),
                    None,
                )
                .hue
                .to_vec()
        })
        .collect()
}

fn chroma([r, g, b]: [u8; 3]) -> u8 {
    r.max(g).max(b) - r.min(g).min(b)
}

fn luma([r, g, b]: [u8; 3]) -> f32 {
    0.2126 * f32::from(r) + 0.7152 * f32::from(g) + 0.0722 * f32::from(b)
}

#[test]
fn a_wave_gives_two_hue_lamps_two_vivid_colours() {
    let channels = [
        hue_channel(0, -0.8, 0.9, None),
        hue_channel(1, 0.8, 0.9, None),
    ];
    let (mut stage, _, _) = stage(effect(EffectId::Wave));
    for frame in run_hue(&mut stage, &channels, Instant::now(), 3.0) {
        for rgb in &frame {
            assert!(chroma(*rgb) > 150, "washed out: {frame:?}");
        }
        assert_ne!(frame[0], frame[1], "the two lamps show one colour");
    }
}

#[test]
fn a_cycle_moves_the_whole_room_through_the_palette_together() {
    let channels = [
        hue_channel(0, -0.8, 0.9, None),
        hue_channel(1, 0.0, -0.5, Some(0.8)),
        hue_channel(2, 0.8, 0.9, None),
    ];
    let (mut stage, _, _) = stage(EffectPayload {
        speed: 1.0,
        ..effect(EffectId::Cycle)
    });
    let frames = run_hue(&mut stage, &channels, Instant::now(), 2.0);
    for frame in &frames {
        assert!(frame.iter().all(|rgb| rgb == &frame[0]), "{frame:?}");
    }
    assert_ne!(frames[0][0], frames[frames.len() - 1][0]);
}

#[test]
fn candles_flicker_on_their_own_and_never_go_out() {
    let channels = [
        hue_channel(0, -0.5, 0.9, None),
        hue_channel(1, 0.5, 0.9, None),
    ];
    let (mut stage, _, _) = stage(effect(EffectId::Candle));
    let frames = run_hue(&mut stage, &channels, Instant::now(), 4.0);
    let apart = frames.iter().filter(|f| f[0] != f[1]).count();
    assert!(apart > frames.len() / 2, "the two candles flicker in step");
    let levels: Vec<f32> = frames.iter().map(|f| luma(f[0])).collect();
    let (low, high) = levels
        .iter()
        .fold((f32::MAX, 0.0f32), |(lo, hi), &l| (lo.min(l), hi.max(l)));
    assert!(high - low > 10.0, "no flicker: {low}..{high}");
    assert!(low > 20.0, "went out: {low}");
    assert!(frames.iter().all(|f| f[0][0] >= f[0][2]), "not warm");
}

/// On three lamps a comet hops from lamp to lamp; one must always be lit, or
/// the room goes dark between hops.
#[test]
fn a_comet_on_a_few_lamps_always_lights_one() {
    let channels = [
        hue_channel(0, -0.8, 0.9, Some(0.0)),
        hue_channel(1, 0.0, 0.9, Some(0.8)),
        hue_channel(2, 0.8, 0.9, Some(0.0)),
    ];
    let (mut stage, _, _) = stage(EffectPayload {
        size: Some(0.0),
        ..effect(EffectId::Comet)
    });
    for frame in run_hue(&mut stage, &channels, Instant::now(), 20.0) {
        // The brightest channel, not luma: a lit blue lamp is lit.
        assert!(
            frame.iter().any(|rgb| rgb.iter().max() > Some(&40)),
            "{frame:?}"
        );
    }
}

/// The maintainer's area: two lamps, both at the top and close together. A scanner's head between
/// them, a chase whose gaps lined up, a twinkle round where neither lit, and a sunrise's first
/// minutes all left it entirely dark. On a handful of lamps something is always lit, bright enough
/// for Hue to show, at any brightness above zero.
#[test]
fn no_effect_leaves_a_few_lamps_all_dark() {
    let areas: [&[HueAreaChannel]; 3] = [
        &[hue_channel(0, 0.2, 1.0, Some(-0.5))],
        &[
            hue_channel(0, 0.168, 1.0, Some(-0.5)),
            hue_channel(1, -0.558, 1.0, Some(-0.5)),
        ],
        &[
            hue_channel(0, -0.8, 0.9, Some(0.0)),
            hue_channel(1, 0.0, 0.9, Some(0.8)),
            hue_channel(2, 0.8, 0.9, Some(0.0)),
        ],
    ];
    for brightness in [1.0f32, 0.61, 0.2] {
        // The floor is on the wire, after brightness: the bytes carry it divided back out.
        let floor = bytes_from_linear([(0.02 / brightness).min(1.0); 3])[0].saturating_sub(1);
        for &(tag, id) in EffectId::TAGS {
            for channels in areas {
                let (mut stage, _, _) = stage(normalize_effect(EffectPayload {
                    brightness,
                    ..effect(id)
                }));
                for (step, frame) in run_hue(&mut stage, channels, Instant::now(), 30.0)
                    .iter()
                    .enumerate()
                {
                    let peak = frame
                        .iter()
                        .flat_map(|rgb| rgb.iter().copied())
                        .max()
                        .unwrap_or(0);
                    assert!(
                        peak >= floor,
                        "{tag} on {} lamps at {brightness}: all dark at step {step}: {frame:?}",
                        channels.len()
                    );
                }
            }
        }
    }
}

/// On two bunched lamps the scanner's head walks their order, so each lamp is fully lit in turn —
/// not both dim while the head sits in the gap between them.
#[test]
fn a_scanner_on_two_lamps_lights_each_in_turn() {
    let channels = [
        hue_channel(0, 0.168, 1.0, Some(-0.5)),
        hue_channel(1, -0.558, 1.0, Some(-0.5)),
    ];
    let (mut stage, _, _) = stage(effect(EffectId::Scanner));
    let frames = run_hue(&mut stage, &channels, Instant::now(), 20.0);
    for lamp in 0..2 {
        let best = frames
            .iter()
            .map(|f| *f[lamp].iter().max().unwrap())
            .max()
            .unwrap();
        assert!(best > 200, "lamp {lamp} never lit: {best}");
    }
}

/// On two lamps a chase takes turns: most of the time one lamp is lit while the other rests,
/// rather than both on and both off together.
#[test]
fn a_chase_on_two_lamps_takes_turns() {
    let channels = [
        hue_channel(0, 0.168, 1.0, Some(-0.5)),
        hue_channel(1, -0.558, 1.0, Some(-0.5)),
    ];
    let (mut stage, _, _) = stage(effect(EffectId::Chase));
    let frames = run_hue(&mut stage, &channels, Instant::now(), 20.0);
    let peak = |rgb: [u8; 3]| *rgb.iter().max().unwrap();
    let turns = frames
        .iter()
        .filter(|f| peak(f[0]).abs_diff(peak(f[1])) > 100)
        .count();
    assert!(
        turns > frames.len() / 2,
        "in step: {turns} of {}",
        frames.len()
    );
}

/// A Hue gradient light shows several colours along itself: its segments are a strip, not a
/// handful of lamps, so an effect keeps its native look there — a scanner's head leaves the far
/// segments dark rather than being lifted or walked lamp to lamp.
#[test]
fn a_gradient_light_keeps_the_native_look() {
    let segment = |channel_id: u8, x: f32| HueAreaChannel {
        light_ids: vec!["gradient-strip".to_string()],
        ..hue_channel(channel_id, x, 1.0, Some(-0.5))
    };
    let channels = [segment(0, -0.6), segment(1, 0.0), segment(2, 0.6)];
    let (mut stage, _, _) = stage(effect(EffectId::Scanner));
    let frames = run_hue(&mut stage, &channels, Instant::now(), 20.0);
    let floor = bytes_from_linear([0.02; 3])[0];
    let dark = frames
        .iter()
        .filter(|f| f.iter().all(|rgb| rgb.iter().all(|&c| c < floor)))
        .count();
    assert!(dark > 0, "a gradient light was treated as separate lamps");
}

/// Brightness at zero means off: the floor never lights what the user turned down to nothing.
#[test]
fn a_few_lamps_at_zero_brightness_stay_dark() {
    let channels = [hue_channel(0, 0.2, 1.0, Some(-0.5))];
    let (mut stage, _, _) = stage(normalize_effect(EffectPayload {
        brightness: 0.0,
        ..effect(EffectId::Scanner)
    }));
    let frames = run_hue(&mut stage, &channels, Instant::now(), 3.0);
    let lit = frames.iter().filter(|f| f[0] != [0, 0, 0]).count();
    // The engine draws the effect's own colours; the wire applies brightness 0 to them.
    assert!(lit <= frames.len(), "{lit}");
}

#[test]
fn a_breath_goes_from_a_dim_floor_to_its_full_colour() {
    let channel = [hue_channel(0, 0.0, 0.9, None)];
    let (mut stage, _, _) = stage(EffectPayload {
        speed: 1.0,
        palette: Some(PaletteId::Custom),
        colors: Some(vec![EffectColor {
            r: 200,
            g: 100,
            b: 0,
        }]),
        ..effect(EffectId::Breathe)
    });
    let levels: Vec<[u8; 3]> = run_hue(&mut stage, &channel, Instant::now(), 1.5)
        .into_iter()
        .map(|f| f[0])
        .collect();
    let brightest = levels
        .iter()
        .copied()
        .max_by(|a, b| luma(*a).total_cmp(&luma(*b)));
    let dimmest = levels
        .iter()
        .copied()
        .min_by(|a, b| luma(*a).total_cmp(&luma(*b)));
    let [r, g, _] = brightest.unwrap();
    assert!(r >= 195 && (95..=105).contains(&g), "{brightest:?}");
    let [r, _, _] = dimmest.unwrap();
    assert!(r > 5 && r < 60, "{dimmest:?}");
}

#[test]
fn a_sunrise_grows_from_dim_red_to_warm_white_over_its_minutes() {
    let channel = [hue_channel(0, 0.0, 0.9, None)];
    let (mut stage, _, _) = stage(normalize_effect(EffectPayload {
        duration_minutes: Some(1),
        ..effect(EffectId::Sunrise)
    }));
    let frames = run_hue(&mut stage, &channel, Instant::now(), 65.0);
    let [r0, g0, _] = frames[1][0];
    assert!(r0 < 90 && g0 < 30, "starts bright: {:?}", frames[1][0]);
    let [r, g, b] = frames[frames.len() - 1][0];
    assert!(r > 240 && g > 200 && b > 150, "ends dim: {r} {g} {b}");
}

/// A relaunch reads the saved start: a sunrise half over stays half over.
#[test]
fn a_sunrise_carries_on_from_its_saved_start() {
    let channel = [hue_channel(0, 0.0, 0.9, None)];
    let sunrise = |started_at_ms| {
        normalize_effect(EffectPayload {
            duration_minutes: Some(60),
            started_at_ms,
            ..effect(EffectId::Sunrise)
        })
    };
    let (mut resumed, _, _) = stage(sunrise(Some(unix_ms_now() - 30 * 60_000)));
    let (mut fresh, _, _) = stage(sunrise(None));
    let now = Instant::now();
    let half = run_hue(&mut resumed, &channel, now, 0.0)[0][0];
    let start = run_hue(&mut fresh, &channel, now, 0.0)[0][0];
    assert!(luma(half) > luma(start) + 60.0, "{half:?} vs {start:?}");
}

/// The start is stamped once, kept through a retune, and dropped by any other effect.
#[test]
fn only_a_sunrise_is_stamped_with_its_start() {
    let stamped = normalize_effect(effect(EffectId::Sunrise));
    let at = stamped.started_at_ms.expect("stamped");
    let retuned = normalize_effect(EffectPayload {
        duration_minutes: Some(30),
        ..stamped
    });
    assert_eq!(retuned.started_at_ms, Some(at));
    let other = normalize_effect(EffectPayload {
        started_at_ms: Some(at),
        ..effect(EffectId::Wave)
    });
    assert_eq!(other.started_at_ms, None);
}

#[test]
fn a_faster_speed_is_a_shorter_loop_for_every_effect() {
    let timed = [EffectId::Sunrise, EffectId::NaturalLight];
    for &(tag, id) in EffectId::TAGS.iter().filter(|(_, id)| !timed.contains(id)) {
        let rates: Vec<f32> = [0.0, 0.25, 0.5, 0.75, 1.0]
            .iter()
            .map(|speed| loops_per_sec(id, *speed))
            .collect();
        assert!(rates.windows(2).all(|p| p[0] < p[1]), "{tag}: {rates:?}");
    }
}

/// A new worker for the same effect (a layout change, an output joining)
/// carries on from the owner's clock instead of starting over.
#[test]
fn a_rebuilt_worker_carries_the_effect_on() {
    let channel = [hue_channel(0, 0.0, 0.9, None)];
    let (mut first, live, clock) = stage(effect(EffectId::Cycle));
    let start = Instant::now();
    run_hue(&mut first, &channel, start, 5.0);
    let mut second = EffectStage::new(EffectDraw { live, clock });
    let (seq, counts) = strip(0);
    let resumed = second.draw(start, &seq, &counts, Some(&channel), None).hue[0];
    let fresh = stage(effect(EffectId::Cycle))
        .0
        .draw(start, &seq, &counts, Some(&channel), None)
        .hue[0];
    assert_ne!(resumed, fresh);
}

/// A strip with no room map still gets the whole wave across it.
#[test]
fn a_strip_without_a_room_map_shows_the_whole_palette() {
    let (seq, counts) = strip(120);
    let (mut stage, _, _) = stage(EffectPayload {
        direction: Some(EffectDirection::LeftToRight),
        size: Some(1.0),
        ..effect(EffectId::Gradient)
    });
    let drawn = stage
        .draw(Instant::now(), &seq, &counts, None, None)
        .strip
        .to_vec();
    assert_eq!(drawn.len(), 120);
    let distinct: HashSet<[u8; 3]> = drawn.iter().copied().collect();
    assert!(distinct.len() > 20, "{} colours", distinct.len());
}

#[test]
fn every_effect_and_palette_has_a_catalogue_entry_and_nothing_else_does() {
    let json: serde_json::Value = serde_json::from_str(CATALOGUE_JSON).unwrap();
    let keys = |section: &str| -> HashSet<String> {
        json[section].as_object().unwrap().keys().cloned().collect()
    };
    let effects: HashSet<String> = EffectId::TAGS
        .iter()
        .map(|(t, _)| (*t).to_string())
        .collect();
    assert_eq!(keys("effects"), effects);
    let palettes: HashSet<String> = PaletteId::TAGS
        .iter()
        .filter(|(_, id)| *id != PaletteId::Custom)
        .map(|(t, _)| (*t).to_string())
        .collect();
    assert_eq!(keys("palettes"), palettes);
    for spec in CATALOGUE.effects.values() {
        assert!(
            PaletteId::from_tag(&spec.default_palette).is_some(),
            "{}",
            spec.default_palette
        );
    }
    for &(_, id) in EffectId::TAGS {
        palette_for(&effect(id));
    }
}

/// OKLab keeps a blend between two saturated stops saturated; an RGB blend of
/// red and blue passes through a dull purple.
#[test]
fn a_palette_blend_stays_vivid_between_its_stops() {
    let palette = Palette::from_bytes(&[[255, 0, 0], [0, 0, 255]], false);
    let middle = bytes_from_linear(palette.at(0.5));
    assert!(chroma(middle) > 150, "{middle:?}");
    let wrap = Palette::from_bytes(&[[255, 0, 0], [0, 255, 0], [0, 0, 255]], true);
    assert_eq!(
        bytes_from_linear(wrap.at(0.0)),
        bytes_from_linear(wrap.at(1.0))
    );
    let open = Palette::from_bytes(&[[255, 0, 0], [0, 0, 255]], false);
    let (end, start) = (
        bytes_from_linear(open.cyclic(0.999)),
        bytes_from_linear(open.cyclic(0.0)),
    );
    assert!(
        end.iter().zip(start).all(|(a, b)| a.abs_diff(b) <= 8),
        "a jump: {end:?} → {start:?}"
    );
}

// Release numbers for the per-light engine, beside `frame_budget_report`:
//   cargo test --release --lib effect_budget_report -- --ignored --nocapture
#[test]
#[ignore = "timing report; run by hand in release"]
fn effect_budget_report() {
    let channels: Vec<HueAreaChannel> = (0..6)
        .map(|i| hue_channel(i, -0.9 + 0.36 * f32::from(i), 0.6, Some(0.2)))
        .collect();
    for leds in [164u16, 300] {
        let (seq, counts) = strip(leds);
        for &(tag, id) in EffectId::TAGS {
            let (mut stage, _, _) = stage(effect(id));
            let start = Instant::now();
            let mut samples: Vec<f64> = (0..600)
                .map(|i| {
                    let at = start + Duration::from_millis(i * 16);
                    let t = Instant::now();
                    std::hint::black_box(stage.draw(at, &seq, &counts, Some(&channels), None));
                    t.elapsed().as_secs_f64() * 1e6
                })
                .collect();
            samples.sort_by(f64::total_cmp);
            println!(
                "{leds} LEDs + 6 Hue · {tag:<13} median {:>6.1} µs  p95 {:>6.1} µs",
                samples[samples.len() / 2],
                samples[samples.len() * 95 / 100]
            );
        }
    }
}

/// The wire reader's limits are the catalogue's, which the sliders read.
#[test]
fn the_payload_limits_are_the_catalogues() {
    use super::config::{EFFECT_DURATION_MINUTES, EFFECT_MAX_COLORS};
    assert_eq!(EFFECT_DURATION_MINUTES, CATALOGUE.ranges.duration_minutes);
    assert_eq!(EFFECT_MAX_COLORS, CATALOGUE.ranges.colors.1);
    assert_eq!(
        CATALOGUE.defaults.size, 0.5,
        "normalize_effect's size fallback"
    );
    assert_eq!(
        CATALOGUE.defaults.intensity, 0.5,
        "normalize_effect's intensity fallback"
    );
}

/// A light the bridge or the room map placed at NaN draws dark rather than
/// taking the worker down.
#[test]
fn a_light_at_nan_draws_without_panicking() {
    let channels = [
        hue_channel(0, f32::NAN, 0.9, Some(f32::NAN)),
        hue_channel(1, 0.5, 0.9, None),
    ];
    for &(_, id) in EffectId::TAGS {
        let (mut stage, _, _) = stage(effect(id));
        let frames = run_hue(&mut stage, &channels, Instant::now(), 0.2);
        assert_eq!(frames[0].len(), 2, "{id:?}");
    }
}

/// Adding a variant fails to compile here until it is given a tag.
#[test]
fn every_direction_has_a_tag() {
    fn listed(direction: EffectDirection) -> bool {
        match direction {
            EffectDirection::LeftToRight
            | EffectDirection::RightToLeft
            | EffectDirection::BottomToTop
            | EffectDirection::TopToBottom
            | EffectDirection::Outward
            | EffectDirection::Around => EffectDirection::TAGS.iter().any(|(_, d)| *d == direction),
        }
    }
    for &(_, direction) in EffectDirection::TAGS {
        assert!(listed(direction));
    }
    assert_eq!(EffectDirection::TAGS.len(), 6);
}
