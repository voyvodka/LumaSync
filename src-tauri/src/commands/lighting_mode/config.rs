//! The mode request itself: what `set_lighting_mode` accepts and answers, and
//! the normalisation every request goes through before the transition reads it.

use serde::{Deserialize, Serialize};

use crate::commands::hue_intensity::{HueIntensityPreset, LightingSmoothingPreset};
use crate::commands::led_calibration::LedCalibrationConfig;
use crate::commands::led_output::{
    ColorCorrectionConfig, FirmwareProfile, LedChipType, LedColorOrder,
};
use crate::commands::status::CommandStatus;
use crate::commands::wled_sink::WledSinkConfig;
use crate::models::room_map::RoomGeometry;

/// A kind this build does not know reads as `Off` (`lenient_enum!` below), so
/// a mode saved by a newer build starts the lights off instead of failing the
/// whole `lightingMode` read.
#[derive(Clone, Copy, Default, Serialize, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum LightingModeKind {
    #[default]
    Off,
    Ambilight,
    Solid,
    /// A procedural animation, run by the Ambilight worker from a synthetic
    /// frame source instead of screen capture.
    Effect,
}

/// `EFFECT_IDS` in `src/shared/contracts/mode.ts`. An id this build does not
/// know reads as `Rainbow`.
#[derive(Clone, Copy, Default, Serialize, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum EffectId {
    #[default]
    Rainbow,
    Breathe,
    Cycle,
}

/// Reads a lowercase tag, falling back to the default for any other string.
/// `#[serde(other)]` would do it only on the last variant.
macro_rules! lenient_enum {
    ($ty:ty { $($tag:literal => $variant:expr),+ $(,)? }) => {
        impl<'de> Deserialize<'de> for $ty {
            fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                let tag = String::deserialize(deserializer)?;
                Ok(match tag.as_str() {
                    $($tag => $variant,)+
                    _ => <$ty>::default(),
                })
            }
        }
    };
}

lenient_enum!(LightingModeKind {
    "off" => LightingModeKind::Off,
    "ambilight" => LightingModeKind::Ambilight,
    "solid" => LightingModeKind::Solid,
    "effect" => LightingModeKind::Effect,
});

lenient_enum!(EffectId {
    "rainbow" => EffectId::Rainbow,
    "breathe" => EffectId::Breathe,
    "cycle" => EffectId::Cycle,
});

#[derive(Clone, Copy, Deserialize, Serialize, PartialEq, Eq, Debug)]
pub struct EffectColor {
    pub r: u8,
    pub g: u8,
    pub b: u8,
}

/// `EffectPayload` in `src/shared/contracts/mode.ts`.
#[derive(Clone, Deserialize, Serialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct EffectPayload {
    #[serde(default)]
    pub id: EffectId,
    /// 0..1, mapped per effect onto a period on a log scale: a breath and a
    /// rainbow lap do not share a sensible range in hertz.
    #[serde(default = "default_effect_speed")]
    pub speed: f32,
    #[serde(default = "default_effect_brightness")]
    pub brightness: f32,
    /// The breath's colour; the rainbow and the cycle ignore it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<EffectColor>,
}

fn default_effect_speed() -> f32 {
    DEFAULT_EFFECT.speed
}

fn default_effect_brightness() -> f32 {
    DEFAULT_EFFECT.brightness
}

/// `DEFAULT_EFFECT` in `src/shared/contracts/mode.ts`.
pub(crate) const DEFAULT_EFFECT: EffectPayload = EffectPayload {
    id: EffectId::Rainbow,
    speed: 0.5,
    brightness: 1.0,
    color: None,
};

#[derive(Clone, Deserialize, Serialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SolidColorPayload {
    pub r: u8,
    pub g: u8,
    pub b: u8,
    pub brightness: f32,
}

/// `DEFAULT_SOLID_COLOR` in `src/shared/contracts/mode.ts`: what Solid shows
/// before any colour was chosen.
pub(crate) const DEFAULT_SOLID: SolidColorPayload = SolidColorPayload {
    r: 255,
    g: 255,
    b: 255,
    brightness: 1.0,
};

/// Tunables for `LightingModeKind::Ambilight` — brightness plus the
/// sampling/smoothing knobs applied on top of raw screen capture.
#[derive(Clone, Deserialize, Serialize, PartialEq, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct AmbilightPayload {
    pub brightness: f32,
    /// Enable automatic letterbox / pillarbox detection.
    /// When true, black borders are detected every ~2.5 s and excluded from sampling.
    #[serde(default)]
    pub black_border_detection: bool,
    /// EWMAalpha for per-frame color smoothing. Range [0.05, 1.0].
    /// 1.0 = instant (no smoothing); lower values = slower, smoother transitions.
    /// Defaults to 0.35 when absent.
    #[serde(default)]
    pub smoothing_alpha: Option<f32>,
    /// Post-sampling color saturation factor. Range [0.5, 2.0].
    /// 1.0 = identity (no change); 0.5 ≈ half-saturated; 2.0 ≈ vivid.
    /// Defaults to 1.0 when absent.
    #[serde(default)]
    pub saturation: Option<f32>,
    /// Unified smoothing preset (v1.4 unification). When present, governs
    /// the EWMA coefficient for both USB and Hue output sinks. Takes
    /// priority over the deprecated `smoothing_alpha` continuous slider
    /// and `hue_intensity_preset`.
    #[serde(default)]
    pub lighting_smoothing_preset: Option<LightingSmoothingPreset>,
    /// Deprecated — use `lighting_smoothing_preset`. Kept for backward
    /// compatibility with pre-v1.4 payloads that still carry this field.
    /// Will be removed in v1.5.
    #[serde(default)]
    pub hue_intensity_preset: Option<HueIntensityPreset>,
}

/// Full desired-state payload for `set_lighting_mode` — mode selection plus
/// every per-mode and per-output setting needed to (re)start the worker.
#[derive(Clone, Deserialize, Serialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LightingModeConfig {
    #[serde(default)]
    pub kind: LightingModeKind,
    #[serde(default)]
    pub solid: Option<SolidColorPayload>,
    #[serde(default)]
    pub ambilight: Option<AmbilightPayload>,
    /// Skipped when absent so a mode that never ran an effect echoes exactly as before.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effect: Option<EffectPayload>,
    #[serde(default)]
    pub targets: Option<Vec<String>>,
    /// Capture display selected by the user.
    /// Absent ⇒ the ambilight worker falls back to the OS primary
    /// display. Matched against the stable `DisplayInfoPayload.id`
    /// produced by `list_displays`; a missing or unplugged id reverts
    /// to primary rather than failing the command.
    #[serde(default)]
    pub display_id: Option<String>,
    /// Per-LED calibration config (v1.4 USB per-LED sampling anchor).
    /// When set, the ambilight worker uses edge-based per-LED sampling
    /// (`build_led_sequence` + `sample_frame_for_sequence`).
    /// When absent, the worker falls back to single-zone sampling.
    #[serde(default)]
    pub led_calibration: Option<LedCalibrationConfig>,
    /// Per-channel color correction applied in the LED encoder.
    /// Absent ⇒ backend uses `ColorCorrectionConfig::default()` (gamma 2.2 / 6500 K / sat 1.0).
    /// Applies to USB output only — Hue sink is not affected.
    #[serde(default)]
    pub color_correction: Option<ColorCorrectionConfig>,
    /// Firmware encoding profile. Absent ⇒ `FirmwareProfile::default()` (LumaSyncV1).
    /// Changing this is a breaking wire-format change — only done via user-visible Firmware Profile
    /// setting; never switched silently.
    #[serde(default)]
    pub firmware_profile: Option<FirmwareProfile>,
    /// LED chip type. Absent ⇒ `LedChipType::default()` (WS2812B GRB).
    /// Changes bytes-per-pixel on the wire, so it also moves the serial timing
    /// budget — see `derive_base_interval_ms_for` / `frame_wire_time_ms`.
    #[serde(default)]
    pub chip_type: Option<LedChipType>,
    /// Host-side colour-order correction relative to the firmware (serial only).
    /// Absent ⇒ `Rgb`, the identity. Retuned live, not by a worker restart.
    /// Skipped when absent so the echoed mode stays byte-identical for everyone
    /// who never set it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color_order: Option<LedColorOrder>,
    /// Room-aware Hue sampling input (P3). Absent ⇒ no TV anchor, and the worker
    /// samples exactly as before. Skipped when absent so the echoed mode stays
    /// byte-identical for a user without a TV anchor.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub room_geometry: Option<RoomGeometry>,
}

impl Default for LightingModeConfig {
    fn default() -> Self {
        Self {
            kind: LightingModeKind::Off,
            solid: None,
            ambilight: None,
            effect: None,
            targets: None,
            display_id: None,
            led_calibration: None,
            color_correction: None,
            firmware_profile: None,
            chip_type: None,
            color_order: None,
            room_geometry: None,
        }
    }
}

/// Response shape shared by `set_lighting_mode`, `stop_lighting`, and
/// `get_lighting_mode_status` — the mode now in effect plus a coded status.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LightingModeCommandResult {
    pub active: bool,
    pub mode: LightingModeConfig,
    pub status: CommandStatus,
    pub wled_advisory: Option<WledLiveFrameAdvisory>,
}

/// Non-fatal notice that the frame length and the bound WLED sink disagree.
///
/// Deliberately not a failure: WLED updates the first N LEDs of a short frame
/// and truncates a long one, so half a lit strip beats none. It exists because
/// "half my strip is dead" reads as a wiring fault, and the user goes looking
/// at solder joints long before suspecting a count mismatch.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WledLiveFrameAdvisory {
    pub code: String,
    pub message: String,
    pub frame_led_count: u16,
    pub sink_led_count: u16,
}

/// Frame LEDs the mode will emit. Mirrors the worker's own derivation — the
/// 1-LED fallback when calibration is absent is the legacy behaviour, not a
/// mismatch worth reporting, so it is filtered out by the caller.
pub(super) fn frame_led_count_for(mode: &LightingModeConfig) -> u16 {
    mode.led_calibration
        .as_ref()
        .map(|cal| cal.total_leds)
        .unwrap_or(1)
}

/// Compare the frame the mode will emit against the bound WLED sink.
pub(super) fn wled_frame_advisory(
    mode: &LightingModeConfig,
    wled_sink: Option<&WledSinkConfig>,
) -> Option<WledLiveFrameAdvisory> {
    let sink = wled_sink?;
    if mode.kind == LightingModeKind::Off {
        return None;
    }
    let frame_led_count = frame_led_count_for(mode);
    if frame_led_count <= 1 || frame_led_count == sink.led_count {
        return None;
    }
    Some(WledLiveFrameAdvisory {
        code: "WLED_LIVE_LED_COUNT_MISMATCH".to_string(),
        message: "The calibrated strip length does not match the LED count reported by the WLED device; part of the strip will not track."
            .to_string(),
        frame_led_count,
        sink_led_count: sink.led_count,
    })
}

fn clamp_u8(value: Option<u8>, fallback: u8) -> u8 {
    value.unwrap_or(fallback)
}

fn clamp_brightness(value: Option<f32>, fallback: f32) -> f32 {
    value.unwrap_or(fallback).clamp(0.0, 1.0)
}

pub(super) fn normalize_mode_config(config: LightingModeConfig) -> LightingModeConfig {
    let targets = config.targets.clone();
    let display_id = config.display_id.clone();
    let led_calibration = config.led_calibration.clone();
    let color_correction = config.color_correction.clone();
    let firmware_profile = config.firmware_profile;
    let chip_type = config.chip_type;
    let color_order = config.color_order;
    match config.kind {
        LightingModeKind::Off => LightingModeConfig {
            targets,
            display_id,
            color_correction,
            firmware_profile,
            chip_type,
            color_order,
            ..LightingModeConfig::default()
        },
        LightingModeKind::Ambilight => {
            let incoming = config.ambilight.unwrap_or_default();
            LightingModeConfig {
                kind: LightingModeKind::Ambilight,
                solid: None,
                ambilight: Some(AmbilightPayload {
                    brightness: clamp_brightness(Some(incoming.brightness), 1.0),
                    black_border_detection: incoming.black_border_detection,
                    smoothing_alpha: incoming.smoothing_alpha,
                    saturation: incoming.saturation,
                    lighting_smoothing_preset: incoming.lighting_smoothing_preset,
                    hue_intensity_preset: incoming.hue_intensity_preset,
                }),
                effect: None,
                targets,
                display_id,
                led_calibration,
                color_correction,
                firmware_profile,
                chip_type,
                color_order,
                // Only the ambilight worker samples by room; Off and Solid drop it.
                room_geometry: config.room_geometry,
            }
        }
        LightingModeKind::Solid => {
            let solid = config.solid.unwrap_or(DEFAULT_SOLID);
            LightingModeConfig {
                kind: LightingModeKind::Solid,
                solid: Some(SolidColorPayload {
                    r: clamp_u8(Some(solid.r), 255),
                    g: clamp_u8(Some(solid.g), 255),
                    b: clamp_u8(Some(solid.b), 255),
                    brightness: clamp_brightness(Some(solid.brightness), 1.0),
                }),
                ambilight: None,
                effect: None,
                targets,
                display_id,
                led_calibration,
                color_correction,
                firmware_profile,
                chip_type,
                color_order,
                room_geometry: None,
            }
        }
        LightingModeKind::Effect => {
            let effect = config.effect.unwrap_or(DEFAULT_EFFECT);
            LightingModeConfig {
                kind: LightingModeKind::Effect,
                solid: None,
                ambilight: None,
                effect: Some(EffectPayload {
                    id: effect.id,
                    speed: clamp_unit(effect.speed, DEFAULT_EFFECT.speed),
                    brightness: clamp_unit(effect.brightness, DEFAULT_EFFECT.brightness),
                    color: effect.color,
                }),
                targets,
                // An effect captures nothing: no display to follow.
                display_id: None,
                led_calibration,
                color_correction,
                firmware_profile,
                chip_type,
                color_order,
                // Drawn in screen space, so Hue samples it by room like Ambilight.
                room_geometry: config.room_geometry,
            }
        }
    }
}

/// A non-finite value is the default, not a clamp to an end.
fn clamp_unit(value: f32, fallback: f32) -> f32 {
    if value.is_finite() {
        value.clamp(0.0, 1.0)
    } else {
        fallback
    }
}
