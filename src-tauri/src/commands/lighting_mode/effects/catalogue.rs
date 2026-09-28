//! `effectCatalogue.json`, read once: the same file the frontend imports
//! (`src/shared/contracts/effects.ts`), so an effect's default palette and a
//! palette's stops cannot differ between what the UI shows and what runs.

use std::collections::HashMap;
use std::sync::LazyLock;

use serde::Deserialize;

use super::palette::Palette;
use crate::commands::lighting_mode::config::{EffectColor, EffectId, EffectPayload, PaletteId};

pub(crate) const CATALOGUE_JSON: &str =
    include_str!("../../../../../src/shared/contracts/effectCatalogue.json");

#[derive(Deserialize)]
pub(crate) struct PaletteSpec {
    pub wrap: bool,
    pub stops: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EffectSpec {
    #[allow(dead_code)]
    pub family: String,
    #[allow(dead_code)]
    pub params: Vec<String>,
    #[allow(dead_code)]
    pub color_source: String,
    pub default_palette: String,
    #[serde(default)]
    pub default_colors: Vec<String>,
    #[allow(dead_code)]
    pub sparse: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EffectDefaults {
    pub size: f32,
    pub intensity: f32,
    pub duration_minutes: u16,
}

/// Read by the frontend's sliders; here only pinned against the wire reader's
/// limits (`effect_engine_tests.rs`).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) struct EffectRanges {
    pub duration_minutes: (u16, u16),
    pub colors: (usize, usize),
}

#[derive(Deserialize)]
pub(crate) struct Catalogue {
    pub palettes: HashMap<String, PaletteSpec>,
    pub effects: HashMap<String, EffectSpec>,
    pub defaults: EffectDefaults,
    #[cfg_attr(not(test), allow(dead_code))]
    pub ranges: EffectRanges,
}

pub(crate) static CATALOGUE: LazyLock<Catalogue> = LazyLock::new(|| {
    serde_json::from_str(CATALOGUE_JSON).expect("effectCatalogue.json is checked by its tests")
});

pub(crate) fn hex_bytes(hex: &str) -> Option<[u8; 3]> {
    let hex = hex.strip_prefix('#')?;
    if hex.len() != 6 {
        return None;
    }
    let byte = |i: usize| u8::from_str_radix(&hex[i..i + 2], 16).ok();
    Some([byte(0)?, byte(2)?, byte(4)?])
}

pub(crate) fn tag<T: serde::Serialize>(value: T) -> String {
    serde_json::to_value(value)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_default()
}

pub(crate) fn spec(id: EffectId) -> &'static EffectSpec {
    CATALOGUE
        .effects
        .get(&tag(id))
        .expect("every EffectId has a catalogue entry (tested)")
}

/// The palette an effect plays: the one it names, else its default; `custom`
/// is the payload's colours, else the effect's default colours.
pub(crate) fn palette_for(effect: &EffectPayload) -> Palette {
    let spec = spec(effect.id);
    let id = effect
        .palette
        .map(tag)
        .unwrap_or_else(|| spec.default_palette.clone());
    if id == tag(PaletteId::Custom) {
        let colors: Vec<[u8; 3]> = match effect.colors.as_deref() {
            Some(colors) if !colors.is_empty() => colors
                .iter()
                .map(|&EffectColor { r, g, b }| [r, g, b])
                .collect(),
            _ => spec
                .default_colors
                .iter()
                .filter_map(|h| hex_bytes(h))
                .collect(),
        };
        return Palette::from_bytes(&colors, false);
    }
    let palette = CATALOGUE
        .palettes
        .get(&id)
        .or_else(|| CATALOGUE.palettes.get(&tag(PaletteId::Rainbow)))
        .expect("the rainbow palette exists (tested)");
    let stops: Vec<[u8; 3]> = palette.stops.iter().filter_map(|h| hex_bytes(h)).collect();
    Palette::from_bytes(&stops, palette.wrap)
}
