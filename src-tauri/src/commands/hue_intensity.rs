//! Hue intensity preset — Rust serde mirror of `HueIntensityPreset` from
//! `src/shared/contracts/hue.ts`.
//!
//! The preset is a user-facing dial (Subtle / Moderate / Intense) that
//! maps to a single EWMA coefficient applied to the per-channel Hue RGB
//! stream in the ambilight worker's Hue branch:
//!
//! ```text
//! smoothed = alpha * newSample + (1 - alpha) * prevSmoothed
//! ```
//!
//! Lower alpha ⇒ heavier smoothing ⇒ calmer lights. Higher alpha ⇒
//! snappier response ⇒ more intense. The three coefficients
//! (0.15 / 0.35 / 0.60) must stay in sync with
//! `HUE_INTENSITY_PRESET_COEFFICIENTS` in the frontend contract —
//! any change that alters the numerics is observable on the wire.
//!
//! This module is intentionally tiny (pure enum + one function) so the
//! v1.5 G8 refactor of `hue_stream_lifecycle.rs` can pull it in without
//! depending on any of the runtime/DTLS plumbing.

use serde::{Deserialize, Serialize};

/// User-facing intensity tier for the ambient Hue stream.
///
/// Mirrors the frontend `HueIntensityPreset` union (`"subtle" |
/// "moderate" | "intense"`). `#[serde(rename_all = "camelCase")]` would
/// already render the variant names as lowercase but we spell it out
/// with `"lowercase"` so the wire format is tied to the smaller set of
/// alphabetic-only strings the frontend contract emits.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum HueIntensityPreset {
    Subtle,
    #[default]
    Moderate,
    Intense,
}

impl HueIntensityPreset {
    /// EWMA coefficient applied to the Hue per-channel stream.
    ///
    /// Must stay in lockstep with `HUE_INTENSITY_PRESET_COEFFICIENTS`
    /// in `src/shared/contracts/hue.ts`. A unit test in this module and
    /// a corresponding frontend vitest lock the numerics on both sides.
    pub fn coefficient(self) -> f32 {
        match self {
            HueIntensityPreset::Subtle => 0.15,
            HueIntensityPreset::Moderate => 0.35,
            HueIntensityPreset::Intense => 0.60,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn coefficients_mirror_frontend_contract() {
        // The three numerics below are the contract of record — changing
        // any of them is a breaking behaviour change visible to users
        // through the Hue stream response curve.
        assert_eq!(HueIntensityPreset::Subtle.coefficient(), 0.15);
        assert_eq!(HueIntensityPreset::Moderate.coefficient(), 0.35);
        assert_eq!(HueIntensityPreset::Intense.coefficient(), 0.60);
    }

    #[test]
    fn coefficient_ordering_is_monotonic_low_to_high() {
        // Subtle must smooth the most (lowest alpha); intense must snap
        // the hardest (highest alpha). Preserves the intuition the
        // frontend copy promises ("calmer" vs "fast-reacting").
        assert!(HueIntensityPreset::Subtle.coefficient() < HueIntensityPreset::Moderate.coefficient());
        assert!(
            HueIntensityPreset::Moderate.coefficient() < HueIntensityPreset::Intense.coefficient()
        );
    }

    #[test]
    fn default_preset_is_moderate() {
        let preset = HueIntensityPreset::default();
        assert_eq!(preset, HueIntensityPreset::Moderate);
    }

    #[test]
    fn serde_round_trip_matches_lowercase_wire_format() {
        let subtle = serde_json::to_string(&HueIntensityPreset::Subtle).expect("serialize subtle");
        assert_eq!(subtle, "\"subtle\"");

        let moderate: HueIntensityPreset =
            serde_json::from_str("\"moderate\"").expect("deserialize moderate");
        assert_eq!(moderate, HueIntensityPreset::Moderate);

        let intense: HueIntensityPreset =
            serde_json::from_str("\"intense\"").expect("deserialize intense");
        assert_eq!(intense, HueIntensityPreset::Intense);
    }
}
