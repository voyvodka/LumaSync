//! Lighting smoothing preset — controls EWMA smoothing for all lighting sinks.
//!
//! `LightingSmoothingPreset` (v1.4 unification) is the single user-facing
//! smoothing dial that drives both USB ambilight and Hue stream response curves
//! through one control. The three coefficients (0.15 / 0.35 / 0.60) are
//! contract-locked with the frontend.
//!
//! `HueIntensityPreset` is a deprecated type alias kept for backward compatibility
//! with previously serialised payloads. It will be removed in v1.5 once the
//! frontend has migrated to `lighting_smoothing_preset`.

use serde::{Deserialize, Serialize};

/// User-facing smoothing tier for all lighting sinks (USB ambilight + Hue stream).
///
/// Unified from the earlier `HueIntensityPreset` (Hue-only) in v1.4 so that
/// one control governs both output paths. The EWMA coefficient is applied to
/// the per-frame colour stream on every active sink:
///
/// ```text
/// smoothed = alpha * newSample + (1 - alpha) * prevSmoothed
/// ```
///
/// Lower alpha ⇒ heavier smoothing ⇒ calmer lights.
/// Higher alpha ⇒ snappier response ⇒ more intense.
///
/// Serde wire format: `"subtle" | "moderate" | "intense"` (lowercase).
/// The three coefficients must stay in sync with `LIGHTING_SMOOTHING_PRESET_COEFFICIENTS`
/// in the frontend contract — any numeric change is observable on the wire.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum LightingSmoothingPreset {
    Subtle,
    #[default]
    Moderate,
    Intense,
}

impl LightingSmoothingPreset {
    /// EWMA coefficient applied to the lighting stream on all sinks.
    ///
    /// Must stay in lockstep with the frontend contract constant.
    pub fn coefficient(self) -> f32 {
        match self {
            LightingSmoothingPreset::Subtle => 0.15,
            LightingSmoothingPreset::Moderate => 0.35,
            LightingSmoothingPreset::Intense => 0.60,
        }
    }
}

/// Deprecated alias for `LightingSmoothingPreset`.
///
/// Kept for backward compatibility with payloads that still carry
/// `hue_intensity_preset`. Will be removed in v1.5.
pub type HueIntensityPreset = LightingSmoothingPreset;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn coefficients_mirror_frontend_contract() {
        assert_eq!(LightingSmoothingPreset::Subtle.coefficient(), 0.15);
        assert_eq!(LightingSmoothingPreset::Moderate.coefficient(), 0.35);
        assert_eq!(LightingSmoothingPreset::Intense.coefficient(), 0.60);
    }

    #[test]
    fn coefficient_ordering_is_monotonic_low_to_high() {
        assert!(
            LightingSmoothingPreset::Subtle.coefficient()
                < LightingSmoothingPreset::Moderate.coefficient()
        );
        assert!(
            LightingSmoothingPreset::Moderate.coefficient()
                < LightingSmoothingPreset::Intense.coefficient()
        );
    }

    #[test]
    fn default_preset_is_moderate() {
        let preset = LightingSmoothingPreset::default();
        assert_eq!(preset, LightingSmoothingPreset::Moderate);
    }

    #[test]
    fn serde_round_trip_matches_lowercase_wire_format() {
        let subtle =
            serde_json::to_string(&LightingSmoothingPreset::Subtle).expect("serialize subtle");
        assert_eq!(subtle, "\"subtle\"");

        let moderate: LightingSmoothingPreset =
            serde_json::from_str("\"moderate\"").expect("deserialize moderate");
        assert_eq!(moderate, LightingSmoothingPreset::Moderate);

        let intense: LightingSmoothingPreset =
            serde_json::from_str("\"intense\"").expect("deserialize intense");
        assert_eq!(intense, LightingSmoothingPreset::Intense);
    }

    /// Type alias backward compat: HueIntensityPreset is the same type.
    #[test]
    fn hue_intensity_preset_alias_is_same_type_as_lighting_smoothing_preset() {
        let via_alias: HueIntensityPreset = LightingSmoothingPreset::Subtle;
        assert_eq!(via_alias.coefficient(), 0.15);
    }

    #[test]
    fn lighting_smoothing_preset_deserialises_from_legacy_hue_intensity_wire_values() {
        // Payloads serialised as HueIntensityPreset must still deserialise correctly
        // because both share the same lowercase wire format.
        let legacy_subtle: LightingSmoothingPreset =
            serde_json::from_str("\"subtle\"").expect("legacy subtle");
        let legacy_intense: LightingSmoothingPreset =
            serde_json::from_str("\"intense\"").expect("legacy intense");
        assert_eq!(legacy_subtle, LightingSmoothingPreset::Subtle);
        assert_eq!(legacy_intense, LightingSmoothingPreset::Intense);
    }
}
