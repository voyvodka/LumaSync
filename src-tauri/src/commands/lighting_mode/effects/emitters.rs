//! Every light an effect colours, in one space: the room map's Hue cube,
//! `[-1, 1]` per axis — x left to right, y depth (+1 the TV wall), z floor to
//! ceiling. An effect is evaluated at each light's position; nothing samples a
//! screen, and nothing here derives a sampling region from a light's distance
//! to a surface.

use std::f32::consts::TAU;

use super::noise::seed_of;
use crate::commands::hue::frame::HueAreaChannel;
use crate::commands::led_calibration::{led_to_screen_pos, LedSegmentCounts, LedSequenceItem};
use crate::commands::room_affinity::DEFAULT_TV_MOUNT_HEIGHT_FRACTION;
use crate::models::room_map::RoomGeometry;

/// Without a room map the screen sits on the TV wall at mid height, this wide
/// and this tall in the cube: an effect then crosses the strip as it would a
/// monitor in the middle of a wall.
const VIRTUAL_SCREEN_HALF_WIDTH: f32 = 0.35;
const VIRTUAL_SCREEN_HALF_HEIGHT: f32 = 0.2;
const SCREEN_ASPECT: f64 = 16.0 / 9.0;

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Emitter {
    pub pos: [f32; 3],
    /// 0..1 along its own output: strip order, or a Hue light's place in the
    /// order around the screen (from the left, over the top), evenly spaced so
    /// a travelling effect hops light to light without a dark gap.
    pub u: f32,
    pub seed: u32,
}

/// The screen in the cube: its centre and half extents along x and z.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Screen {
    pub center: [f32; 3],
    pub half_width: f32,
    pub half_height: f32,
}

const VIRTUAL_SCREEN: Screen = Screen {
    center: [0.0, 1.0, 0.0],
    half_width: VIRTUAL_SCREEN_HALF_WIDTH,
    half_height: VIRTUAL_SCREEN_HALF_HEIGHT,
};

/// The screen from the room map's TV anchor, or the virtual one when there is
/// no usable anchor.
pub(crate) fn screen_in_room(geometry: Option<&RoomGeometry>) -> Screen {
    let Some(g) = geometry else {
        return VIRTUAL_SCREEN;
    };
    let d = &g.dimensions;
    let (w, depth, h) = (d.width_meters, d.depth_meters, d.height_meters);
    let tv = &g.tv;
    let usable = [w, depth, h].iter().all(|v| v.is_finite() && *v > 0.0)
        && [tv.x, tv.y, tv.width].iter().all(|v| v.is_finite())
        && tv.width > 0.0;
    if !usable {
        return VIRTUAL_SCREEN;
    }
    let mount = tv
        .mount_height_meters
        .filter(|m| m.is_finite() && (0.0..=h).contains(m))
        .unwrap_or(h * DEFAULT_TV_MOUNT_HEIGHT_FRACTION);
    let to_x = |m: f64| (m / w * 2.0 - 1.0) as f32;
    let to_y = |m: f64| (1.0 - m / depth * 2.0) as f32;
    let to_z = |m: f64| (m / h * 2.0 - 1.0) as f32;
    let centre_x = tv.x + tv.width / 2.0;
    Screen {
        center: [to_x(centre_x), to_y(tv.y), to_z(mount)],
        half_width: (tv.width / w) as f32,
        half_height: (tv.width / SCREEN_ASPECT / h) as f32,
    }
}

/// The strip's LEDs around the screen, in strip order.
pub(crate) fn strip_emitters(
    sequence: &[LedSequenceItem],
    counts: &LedSegmentCounts,
    screen: &Screen,
) -> Vec<Emitter> {
    let last = sequence.len().saturating_sub(1).max(1) as f32;
    sequence
        .iter()
        .enumerate()
        .map(|(i, item)| {
            let (sx, sy) = led_to_screen_pos(item, counts);
            Emitter {
                pos: [
                    screen.center[0] + (sx * 2.0 - 1.0) * screen.half_width,
                    screen.center[1],
                    screen.center[2] + (1.0 - sy * 2.0) * screen.half_height,
                ],
                u: i as f32 / last,
                seed: seed_of(&[1, i as u32]),
            }
        })
        .collect()
}

/// Hue channels where the room map (or, without one, the bridge) puts them.
/// A light with no height is at the screen's.
pub(crate) fn hue_emitters(
    channels: &[HueAreaChannel],
    geometry: Option<&RoomGeometry>,
    screen: &Screen,
) -> Vec<Emitter> {
    let mut placed = channels.to_vec();
    if let Some(g) = geometry {
        crate::commands::hue::sender::apply_channel_placements(&mut placed, &g.hue_placements);
    }
    let mut emitters: Vec<Emitter> = placed
        .iter()
        .map(|ch| {
            let pos = [
                ch.position_x.clamp(-1.0, 1.0),
                ch.position_y.clamp(-1.0, 1.0),
                ch.position_z
                    .map_or(screen.center[2], |z| z.clamp(-1.0, 1.0)),
            ];
            let angle = (pos[2] - screen.center[2]).atan2(screen.center[0] - pos[0]);
            Emitter {
                pos,
                u: (angle / TAU).rem_euclid(1.0),
                seed: seed_of(&[2, u32::from(ch.channel_id)]),
            }
        })
        .collect();
    let mut order: Vec<usize> = (0..emitters.len()).collect();
    order.sort_by(|&a, &b| emitters[a].u.total_cmp(&emitters[b].u));
    let n = emitters.len().max(1) as f32;
    for (rank, i) in order.into_iter().enumerate() {
        emitters[i].u = rank as f32 / n;
    }
    emitters
}

/// Extents over every light the effect drives, so one wave crosses the strip
/// and the room's lamps as one field.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Bounds {
    pub min: [f32; 3],
    pub max: [f32; 3],
    pub screen: Screen,
    /// Farthest light from the screen centre.
    pub reach: f32,
}

impl Bounds {
    pub(crate) fn over<'a>(emitters: impl Iterator<Item = &'a Emitter>, screen: Screen) -> Self {
        let mut min = [f32::INFINITY; 3];
        let mut max = [f32::NEG_INFINITY; 3];
        let mut reach = 0.0f32;
        for e in emitters {
            for axis in 0..3 {
                min[axis] = min[axis].min(e.pos[axis]);
                max[axis] = max[axis].max(e.pos[axis]);
            }
            reach = reach.max(distance(e.pos, screen.center));
        }
        if !min[0].is_finite() {
            (min, max) = ([-1.0; 3], [1.0; 3]);
        }
        Self {
            min,
            max,
            screen,
            reach,
        }
    }

    /// Where `value` lies across the lights along `axis`, 0..1; the middle
    /// when they all share it.
    pub(crate) fn across(&self, axis: usize, value: f32) -> f32 {
        let span = self.max[axis] - self.min[axis];
        if span < 1e-3 {
            0.5
        } else {
            ((value - self.min[axis]) / span).clamp(0.0, 1.0)
        }
    }

    pub(crate) fn outward(&self, pos: [f32; 3]) -> f32 {
        if self.reach < 1e-3 {
            0.0
        } else {
            (distance(pos, self.screen.center) / self.reach).clamp(0.0, 1.0)
        }
    }
}

fn distance(a: [f32; 3], b: [f32; 3]) -> f32 {
    ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2)).sqrt()
}
