//! Room-aware Hue sampling: where on the screen a channel samples, and how much
//! of the frame-wide ambience it takes, from its position in the room relative
//! to the TV. Pure — no I/O, no state. See docs/architecture/room-map.md.
//!
//! Distance only ever chooses the sample point and the ambience blend. It never
//! widens or narrows the sample window and never drops a light, and affinity
//! never falls below `ROOM_AFFINITY_FLOOR`, so the farthest light still keeps
//! part of its own screen region.

use crate::commands::hue::frame::HueAreaChannel;
use crate::models::room_map::RoomGeometry;

/// Screen centre above the floor, as a fraction of the room height, when the
/// TV anchor carries no explicit mount height.
pub const DEFAULT_TV_MOUNT_HEIGHT_FRACTION: f64 = 0.4;

/// Affinity at the farthest point in the room. Without it a far light takes
/// the frame-wide ambience alone and loses its side of the picture entirely.
pub const ROOM_AFFINITY_FLOOR: f64 = 0.25;

/// One channel's room-aware sampling input. `sample_x`/`sample_y` are in the
/// sampler's `[-1, 1]` screen space (`+y` = top row); `affinity` feeds the
/// scene stage (`1` = at the screen, `ROOM_AFFINITY_FLOOR` = the farthest point
/// in the room).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct HueRoomSample {
    pub sample_x: f32,
    pub sample_y: f32,
    pub affinity: f32,
}

/// The geometry reduced to what the per-channel maths reads, once validated.
struct ResolvedRoom {
    width: f64,
    depth: f64,
    height: f64,
    screen_x: f64,
    screen_y: f64,
    half_tv_width: f64,
    mount: f64,
    max_distance: f64,
}

fn resolve(geometry: &RoomGeometry) -> Result<ResolvedRoom, &'static str> {
    let dims = &geometry.dimensions;
    let (width, depth, height) = (dims.width_meters, dims.depth_meters, dims.height_meters);
    if ![width, depth, height]
        .iter()
        .all(|v| v.is_finite() && *v > 0.0)
    {
        return Err("room dimensions must be finite and positive");
    }
    let tv = &geometry.tv;
    if ![tv.x, tv.y, tv.width, tv.height]
        .iter()
        .all(|v| v.is_finite())
        || tv.width <= 0.0
        || tv.height < 0.0
    {
        return Err("TV footprint must be finite with a positive width");
    }
    let screen_x = tv.x + tv.width / 2.0;
    let screen_y = tv.y;
    if !(0.0..=width).contains(&screen_x) || !(0.0..=depth).contains(&screen_y) {
        return Err("TV centre lies outside the room");
    }
    let mount = match tv.mount_height_meters {
        Some(m) if m.is_finite() && (0.0..=height).contains(&m) => m,
        Some(_) => return Err("TV mount height lies outside the room"),
        None => height * DEFAULT_TV_MOUNT_HEIGHT_FRACTION,
    };
    let placements_finite = geometry.hue_placements.iter().all(|p| {
        p.position_x.is_finite()
            && p.position_y.is_finite()
            && p.position_z.is_none_or(f32::is_finite)
    });
    if !placements_finite {
        return Err("a Hue placement is not finite");
    }
    let far = |centre: f64, extent: f64| centre.max(extent - centre);
    let max_distance =
        (far(screen_x, width).powi(2) + far(screen_y, depth).powi(2) + far(mount, height).powi(2))
            .sqrt();
    Ok(ResolvedRoom {
        width,
        depth,
        height,
        screen_x,
        screen_y,
        half_tv_width: tv.width / 2.0,
        mount,
        max_distance,
    })
}

/// Why `room_aware_hue_samples` would return `None`, for the log line.
pub fn room_geometry_rejection(geometry: &RoomGeometry) -> Option<&'static str> {
    resolve(geometry).err()
}

/// Per-channel sample point and affinity, in `channels` order. `None` when the
/// geometry is unusable; the caller then keeps the legacy path.
pub fn room_aware_hue_samples(
    geometry: &RoomGeometry,
    channels: &[HueAreaChannel],
) -> Option<Vec<HueRoomSample>> {
    let room = resolve(geometry).ok()?;
    Some(channels.iter().map(|ch| room.sample(ch)).collect())
}

impl ResolvedRoom {
    fn sample(&self, ch: &HueAreaChannel) -> HueRoomSample {
        // Hue cube → room metres. Hue +y is the TV wall, room +y points away from it.
        let hx = f64::from(ch.position_x.clamp(-1.0, 1.0));
        let hy = f64::from(ch.position_y.clamp(-1.0, 1.0));
        let x_m = (hx + 1.0) / 2.0 * self.width;
        let y_m = (1.0 - hy) / 2.0 * self.depth;
        // An unknown height samples at the screen's own height rather than letting
        // depth stand in for it, which is what the legacy path does.
        let z_m = ch
            .position_z
            .map(|hz| (f64::from(hz.clamp(-1.0, 1.0)) + 1.0) / 2.0 * self.height)
            .unwrap_or(self.mount);

        let sample_x = ((x_m - self.screen_x) / self.half_tv_width).clamp(-1.0, 1.0);
        let sample_y = if z_m < self.mount {
            (z_m - self.mount) / self.mount
        } else if z_m > self.mount {
            (z_m - self.mount) / (self.height - self.mount)
        } else {
            0.0
        };

        let distance = ((x_m - self.screen_x).powi(2)
            + (y_m - self.screen_y).powi(2)
            + (z_m - self.mount).powi(2))
        .sqrt();
        let nearness = 1.0 - distance / self.max_distance;
        let affinity = (ROOM_AFFINITY_FLOOR + (1.0 - ROOM_AFFINITY_FLOOR) * nearness)
            .clamp(ROOM_AFFINITY_FLOOR, 1.0);

        HueRoomSample {
            sample_x: sample_x as f32,
            sample_y: sample_y.clamp(-1.0, 1.0) as f32,
            affinity: affinity as f32,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::hue::frame::HueScreenRegion;
    use crate::commands::hue::state_store::HueChannelPlacementOverride;
    use crate::models::room_map::{RoomDimensions, TvAnchorPlacement};

    /// 4 m wide, 5 m deep, 2.5 m high; a 1.2 m TV centred on the TV wall.
    fn room(mount: Option<f64>) -> RoomGeometry {
        RoomGeometry {
            dimensions: RoomDimensions {
                width_meters: 4.0,
                depth_meters: 5.0,
                height_meters: 2.5,
            },
            tv: TvAnchorPlacement {
                x: 1.4,
                y: 0.0,
                width: 1.2,
                height: 0.1,
                locked: None,
                mount_height_meters: mount,
            },
            hue_placements: Vec::new(),
        }
    }

    fn channel(x: f32, y: f32, z: Option<f32>) -> HueAreaChannel {
        HueAreaChannel {
            channel_id: 0,
            light_ids: vec!["l".to_string()],
            screen_region: HueScreenRegion::Center,
            position_x: x,
            position_y: y,
            position_z: z,
        }
    }

    fn one(geometry: &RoomGeometry, ch: HueAreaChannel) -> HueRoomSample {
        room_aware_hue_samples(geometry, &[ch]).expect("valid geometry")[0]
    }

    /// Hue z for a height in metres in the 2.5 m room.
    fn hz(metres: f64) -> f32 {
        (metres / 2.5 * 2.0 - 1.0) as f32
    }

    #[test]
    fn height_picks_the_screen_band_floor_mount_ceiling() {
        let geo = room(None); // mount = 1.0 m
        let floor = one(&geo, channel(0.0, 1.0, Some(-1.0)));
        let mount = one(&geo, channel(0.0, 1.0, Some(hz(1.0))));
        let ceiling = one(&geo, channel(0.0, 1.0, Some(1.0)));
        let half_below = one(&geo, channel(0.0, 1.0, Some(hz(0.5))));
        let half_above = one(&geo, channel(0.0, 1.0, Some(hz(1.75))));
        assert!((floor.sample_y + 1.0).abs() < 1e-5, "{floor:?}");
        assert!(mount.sample_y.abs() < 1e-5, "{mount:?}");
        assert!((ceiling.sample_y - 1.0).abs() < 1e-5, "{ceiling:?}");
        assert!((half_below.sample_y + 0.5).abs() < 1e-5, "{half_below:?}");
        assert!((half_above.sample_y - 0.5).abs() < 1e-5, "{half_above:?}");
    }

    #[test]
    fn an_explicit_mount_height_overrides_the_default() {
        let geo = room(Some(2.0));
        let at_default = one(&geo, channel(0.0, 1.0, Some(hz(1.0))));
        assert!((at_default.sample_y + 0.5).abs() < 1e-5, "{at_default:?}");
        let at_mount = one(&geo, channel(0.0, 1.0, Some(hz(2.0))));
        assert!(at_mount.sample_y.abs() < 1e-5, "{at_mount:?}");
    }

    #[test]
    fn a_mount_at_the_ceiling_does_not_divide_by_zero() {
        let geo = room(Some(2.5));
        let top = one(&geo, channel(0.0, 1.0, Some(1.0)));
        assert_eq!(top.sample_y, 0.0);
        assert!(top.affinity.is_finite());
    }

    #[test]
    fn an_unknown_height_samples_at_mount_height_whatever_its_depth() {
        let geo = room(None);
        for y in [1.0, 0.0, -1.0] {
            let s = one(&geo, channel(0.0, y, None));
            assert_eq!(s.sample_y, 0.0, "depth {y} must not drive vertical");
        }
    }

    #[test]
    fn horizontal_is_relative_to_the_tv_and_clamps() {
        let geo = room(None); // TV spans x 1.4..2.6 m, centre 2.0 m = Hue x 0
        assert!(one(&geo, channel(0.0, 1.0, None)).sample_x.abs() < 1e-5);
        // Hue x 0.3 → 2.6 m, the TV's right edge.
        assert!((one(&geo, channel(0.3, 1.0, None)).sample_x - 1.0).abs() < 1e-5);
        assert!((one(&geo, channel(-0.3, 1.0, None)).sample_x + 1.0).abs() < 1e-5);
        assert_eq!(one(&geo, channel(1.0, 1.0, None)).sample_x, 1.0);
        assert_eq!(one(&geo, channel(-1.0, 1.0, None)).sample_x, -1.0);
    }

    #[test]
    fn affinity_falls_monotonically_with_distance_from_the_screen() {
        let geo = room(None);
        let at_screen = one(&geo, channel(0.0, 1.0, Some(hz(1.0))));
        assert!((at_screen.affinity - 1.0).abs() < 1e-5, "{at_screen:?}");
        let mut previous = at_screen.affinity;
        for y in [0.6, 0.2, -0.2, -0.6, -1.0] {
            let a = one(&geo, channel(0.0, y, Some(hz(1.0)))).affinity;
            assert!(
                a < previous,
                "affinity must fall as the light moves away: {a} !< {previous}"
            );
            previous = a;
        }
        assert!(previous > ROOM_AFFINITY_FLOOR as f32, "{previous}");
    }

    #[test]
    fn the_farthest_corner_keeps_exactly_the_floor() {
        // Back wall, right side, the ceiling — farther from the 1.0 m mount than the floor.
        let corner = one(&room(None), channel(1.0, -1.0, Some(1.0))).affinity;
        // Pinned as a literal: comparing against the constant alone would pass
        // with the floor set to 0, which is the regression this guards.
        assert!(
            (corner - 0.25).abs() < 1e-5,
            "farthest corner must keep a quarter of its own region, got {corner}"
        );
    }

    #[test]
    fn affinity_is_monotonic_from_the_screen_centre_to_the_farthest_corner() {
        let geo = room(None);
        let steps = 20;
        let mut previous = f32::INFINITY;
        for i in 0..=steps {
            let t = i as f32 / steps as f32;
            // Straight line from the screen centre (Hue 0, 1, mount) to the far corner.
            let z = hz(1.0) + t * (1.0 - hz(1.0));
            let a = one(&geo, channel(t, 1.0 - 2.0 * t, Some(z))).affinity;
            assert!(a < previous, "step {i}: {a} !< {previous}");
            assert!(
                (ROOM_AFFINITY_FLOOR as f32 - 1e-5..=1.0 + 1e-5).contains(&a),
                "{a}"
            );
            previous = a;
        }
        assert!((previous - ROOM_AFFINITY_FLOOR as f32).abs() < 1e-5);
    }

    #[test]
    fn no_light_is_ever_excluded() {
        let geo = room(None);
        let mut channels = Vec::new();
        for x in [-1.0, -0.5, 0.0, 0.5, 1.0] {
            for y in [-1.0, 0.0, 1.0] {
                for z in [None, Some(-1.0), Some(0.0), Some(1.0)] {
                    channels.push(channel(x, y, z));
                }
            }
        }
        let samples = room_aware_hue_samples(&geo, &channels).expect("valid");
        assert_eq!(samples.len(), channels.len());
        for s in samples {
            for v in [s.sample_x, s.sample_y] {
                assert!(v.is_finite() && (-1.0..=1.0).contains(&v), "{s:?}");
            }
            assert!(
                s.affinity.is_finite() && (ROOM_AFFINITY_FLOOR as f32..=1.0).contains(&s.affinity),
                "{s:?}"
            );
        }
    }

    #[test]
    fn invalid_geometry_is_rejected_not_guessed() {
        let mut cases: Vec<RoomGeometry> = Vec::new();
        let mut zero_room = room(None);
        zero_room.dimensions.width_meters = 0.0;
        cases.push(zero_room);
        let mut nan_height = room(None);
        nan_height.dimensions.height_meters = f64::NAN;
        cases.push(nan_height);
        let mut zero_tv = room(None);
        zero_tv.tv.width = 0.0;
        cases.push(zero_tv);
        let mut outside = room(None);
        outside.tv.x = 10.0;
        cases.push(outside);
        let mut behind = room(None);
        behind.tv.y = -0.5;
        cases.push(behind);
        cases.push(room(Some(3.0)));
        cases.push(room(Some(-0.1)));
        let mut bad_placement = room(None);
        bad_placement
            .hue_placements
            .push(HueChannelPlacementOverride {
                channel_id: 0,
                position_x: f32::NAN,
                position_y: 0.0,
                position_z: None,
            });
        cases.push(bad_placement);

        for geo in cases {
            assert!(
                room_aware_hue_samples(&geo, &[channel(0.0, 0.0, None)]).is_none(),
                "{geo:?} must be rejected"
            );
            assert!(room_geometry_rejection(&geo).is_some());
        }
        assert!(room_geometry_rejection(&room(None)).is_none());
    }
}
