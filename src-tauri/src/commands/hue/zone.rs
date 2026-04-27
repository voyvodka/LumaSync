//! Hue zone state machine (v1.5 W1-A3 — logical-grouping zones).
//!
//! Scope (v1.5 D2 — locked, scope (a) "logical grouping"):
//! - A zone is purely a UI / authoring concept that lives **inside one
//!   entertainment area**. The bridge state machine is untouched, no
//!   multi-stream mux, no DTLS surface change.
//! - Channels keep their bridge-assigned `channel_index`. The zone only
//!   provides a center+scale frame that the room-map editor uses to
//!   manipulate a subset of bulbs as a unit.
//! - World-space position resolves at frame-build time as
//!   `world = center + scale * zone_relative_position`. The transform
//!   helper lives here too so that downstream callers (`frame.rs`,
//!   `commands.rs`) can opt into zone awareness without re-deriving the
//!   math.
//!
//! Persistence: the canonical zone list lives in `RoomMapConfig.hue_zones`
//! on the frontend `shellStore`. These commands do **not** persist on
//! their own — the frontend round-trips the mutated `RoomMapConfig` back
//! to `save_room_map`. Each command therefore takes the current
//! `Vec<HueZone>` (and, when relevant, `Vec<HueChannelPlacement>`) as
//! input and returns the mutated copy plus a `CommandStatus` carrying a
//! stable `HUE_ZONE_*` code from `src/shared/contracts/hue.ts`.

use serde::{Deserialize, Serialize};

use super::super::hue_onboarding::CommandStatus;
use crate::models::room_map::{HueChannelPlacement, HueZone, ZoneRelativePosition};

// ---------------------------------------------------------------------------
// Constants & status codes
// ---------------------------------------------------------------------------

/// Bridge-side per-area channel cap (Hue Entertainment API v2.0). Mirrors
/// the limit advertised by `entertainment_configuration` resources. Used
/// to surface `HUE_ZONE_LIMIT_REACHED` when a zone tries to grow past
/// what the area itself can accept.
pub(crate) const HUE_AREA_CHANNEL_LIMIT: usize = 10;

/// Lower clamp for zone scale on the X/Y axes. Matches the Inspector
/// slider floor — anything smaller and the zone bounds box collapses to a
/// degenerate point, and the per-channel relative coordinates lose
/// authoring resolution. Z is intentionally exempt (out of authoring
/// scope until the height-axis UI lands).
pub(crate) const HUE_ZONE_SCALE_MIN: f64 = 0.05;

/// Upper clamp for zone scale on the X/Y axes. `1.0` ⇒ zone half-axis
/// covers the full Hue cube (i.e. zone is the whole room). Beyond this
/// the bounds box would overflow the room map AND the bridge cube — both
/// invalid. The user spec allows zone-size == room-size, but never
/// strictly larger.
pub(crate) const HUE_ZONE_SCALE_MAX: f64 = 1.0;

/// Floating-point slack used when verifying the cube-overflow invariant
/// (`|center| + |scale| <= 1.0`). Tauri's JSON bridge can introduce
/// ~1e-12 jitter on values the frontend authored exactly at the limit;
/// this tolerance keeps a legitimate "zone == room" write from being
/// rejected while still catching real overflow. (v1.5 W4-I — was the
/// uniform aspect-ratio tolerance under W4-C; the AR lock is gone now
/// that zones are physical metric squares authored by the frontend with
/// asymmetric `scale_x` / `scale_y` for non-square rooms.)
const HUE_ZONE_BOUNDS_TOLERANCE: f64 = 1e-6;

const STATUS_ZONE_CREATED: &str = "HUE_ZONE_CREATED";
const STATUS_ZONE_UPDATED: &str = "HUE_ZONE_UPDATED";
const STATUS_ZONE_DELETED: &str = "HUE_ZONE_DELETED";
const STATUS_ZONE_NOT_FOUND: &str = "HUE_ZONE_NOT_FOUND";
const STATUS_ZONE_OUT_OF_BOUNDS: &str = "HUE_ZONE_CHANNEL_OUT_OF_BOUNDS";
const STATUS_ZONE_LIMIT_REACHED: &str = "HUE_ZONE_LIMIT_REACHED";
const STATUS_ZONE_CHANNEL_NOT_IN_AREA: &str = "HUE_ZONE_CHANNEL_NOT_IN_AREA";
/// Zone scale is outside `[HUE_ZONE_SCALE_MIN, HUE_ZONE_SCALE_MAX]` on
/// at least one axis, or non-finite. Distinct from
/// `HUE_ZONE_CHANNEL_OUT_OF_BOUNDS` (per-channel relative drift) because
/// the cause is a slider the user pulled past the room-equals-zone
/// ceiling — recovery is "shrink the zone", not "drag the channel back
/// inside". (W4-I update: the previous W4-C uniform aspect-ratio lock
/// was dropped — zones are 1:1 physical squares now, which means
/// `scale_x` and `scale_y` are intentionally unequal in non-square
/// rooms. Each axis is still clamped independently.)
const STATUS_ZONE_OVERSIZED: &str = "HUE_ZONE_OVERSIZED";

// ---------------------------------------------------------------------------
// Request / response payloads
// ---------------------------------------------------------------------------

/// Request payload for `create_hue_zone`. The frontend sends the active
/// `RoomMapConfig.hue_zones` along with the new zone draft so the
/// command can validate uniqueness without persisting state itself.
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CreateZoneRequest {
    pub zone: HueZone,
    #[serde(default)]
    pub existing_zones: Vec<HueZone>,
}

/// Request payload for `update_hue_zone`. The mutated zone is matched by
/// `zone.id`; a missing match yields `HUE_ZONE_NOT_FOUND`.
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UpdateZoneRequest {
    pub zone: HueZone,
    #[serde(default)]
    pub existing_zones: Vec<HueZone>,
}

/// Request payload for `delete_hue_zone`. Channels referencing the
/// deleted zone fall back to legacy absolute placement (zone_id cleared).
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DeleteZoneRequest {
    pub zone_id: String,
    #[serde(default)]
    pub existing_zones: Vec<HueZone>,
    #[serde(default)]
    pub channels: Vec<HueChannelPlacement>,
}

/// Request payload for `assign_channel_to_zone`. Moves a single channel
/// into the target zone (or detaches it when `zone_id` is `None`).
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AssignChannelRequest {
    pub channel_index: u8,
    /// `Some(zone_id)` to attach, `None` to detach (legacy absolute mode).
    pub zone_id: Option<String>,
    /// Required when `zone_id` is `Some(_)`; ignored on detach.
    pub zone_relative_position: Option<ZoneRelativePosition>,
    /// Entertainment area id of the channel — must match the zone's
    /// `entertainmentAreaId` or `HUE_ZONE_CHANNEL_NOT_IN_AREA` is
    /// returned.
    pub entertainment_area_id: String,
    #[serde(default)]
    pub existing_zones: Vec<HueZone>,
    #[serde(default)]
    pub channels: Vec<HueChannelPlacement>,
}

/// Common response for the four zone authoring commands. The mutated
/// arrays are echoed back so the frontend can write them straight into
/// the next `save_room_map` payload without re-merging.
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ZoneCommandResult {
    pub status: CommandStatus,
    pub zones: Vec<HueZone>,
    pub channels: Vec<HueChannelPlacement>,
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

fn in_unit_range(value: f64) -> bool {
    (-1.0..=1.0).contains(&value)
}

fn is_zone_relative_in_bounds(rel: &ZoneRelativePosition) -> bool {
    in_unit_range(rel.x) && in_unit_range(rel.y) && in_unit_range(rel.z)
}

fn out_of_bounds_axis(rel: &ZoneRelativePosition) -> &'static str {
    if !in_unit_range(rel.x) {
        "x"
    } else if !in_unit_range(rel.y) {
        "y"
    } else {
        "z"
    }
}

fn zone_center_in_bounds(zone: &HueZone) -> bool {
    in_unit_range(zone.center_x) && in_unit_range(zone.center_y) && in_unit_range(zone.center_z)
}

fn validate_zone_shape(zone: &HueZone) -> Result<(), CommandStatus> {
    if zone.id.trim().is_empty() {
        return Err(CommandStatus {
            code: STATUS_ZONE_OUT_OF_BOUNDS.to_string(),
            message: "Zone id must be non-empty.".to_string(),
            details: None,
        });
    }
    if zone.entertainment_area_id.trim().is_empty() {
        return Err(CommandStatus {
            code: STATUS_ZONE_CHANNEL_NOT_IN_AREA.to_string(),
            message: "Zone entertainment area id must be non-empty.".to_string(),
            details: None,
        });
    }
    if !zone_center_in_bounds(zone) {
        return Err(CommandStatus {
            code: STATUS_ZONE_OUT_OF_BOUNDS.to_string(),
            message: "Zone center must lie within the [-1, 1] cube.".to_string(),
            details: None,
        });
    }
    // ── v1.5 W4-I: per-axis scale ceiling, no aspect-ratio lock ──
    //
    // Zones are now authored as physical 1:1 metric squares: a single
    // edge length in metres maps to `scale_x = edge / room_width_m` and
    // `scale_y = edge / room_depth_m`. In a non-square room those two
    // numbers are intentionally unequal in cube space — that is the
    // *whole point* of the W4-I revision (the previous W4-C lockstep
    // gave a square in cube space, which renders as a room-AR rectangle
    // on the metric canvas — the visual bug the user reported).
    //
    // Backend therefore validates each axis independently against the
    // [MIN, MAX] band and against the cube-overflow invariant, but
    // never checks `scale_x == scale_y`. NaN / Infinity / negative /
    // sub-floor / above-ceiling values are still flagged so the UI can
    // surface a clamp hint instead of letting them round-trip into the
    // runtime sampler.
    let sx = zone.scale_x;
    let sy = zone.scale_y;
    if !sx.is_finite() || !sy.is_finite() {
        return Err(CommandStatus {
            code: STATUS_ZONE_OVERSIZED.to_string(),
            message: "Zone scale must be a finite number.".to_string(),
            details: None,
        });
    }
    if !(HUE_ZONE_SCALE_MIN..=HUE_ZONE_SCALE_MAX).contains(&sx)
        || !(HUE_ZONE_SCALE_MIN..=HUE_ZONE_SCALE_MAX).contains(&sy)
    {
        let axis = if !(HUE_ZONE_SCALE_MIN..=HUE_ZONE_SCALE_MAX).contains(&sx) {
            "x"
        } else {
            "y"
        };
        return Err(CommandStatus {
            code: STATUS_ZONE_OVERSIZED.to_string(),
            message: format!(
                "Zone `{axis}` scale must be in [{HUE_ZONE_SCALE_MIN:.2}, {HUE_ZONE_SCALE_MAX:.2}]; \
                 zone cannot be larger than the room."
            ),
            details: None,
        });
    }
    // Bug #50/#53 invariant — `|center| + halfScale <= 1.0` so the zone
    // bounds box never overflows the Hue cube. Center drag enforces this
    // imperatively; create/update enforce it declaratively here.
    let half_x = sx;
    let half_y = sy;
    if zone.center_x.abs() + half_x > 1.0 + HUE_ZONE_BOUNDS_TOLERANCE
        || zone.center_y.abs() + half_y > 1.0 + HUE_ZONE_BOUNDS_TOLERANCE
    {
        return Err(CommandStatus {
            code: STATUS_ZONE_OUT_OF_BOUNDS.to_string(),
            message: "Zone bounds escape the room cube; shrink the zone or recenter it."
                .to_string(),
            details: None,
        });
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Coordinate transform (consumed by frame builder + tests)
// ---------------------------------------------------------------------------

/// Resolve a zone-relative position into world space. The world axes
/// follow the same `[-1, 1]` Hue native space used by
/// `HueChannelPlacement.{x,y,z}` and bridge channel positions.
///
/// `world.x = center.x + scale.x * relative.x` (and analogously for y, z).
pub fn world_pos_from_zone_relative(
    zone: &HueZone,
    relative: &ZoneRelativePosition,
) -> (f64, f64, f64) {
    (
        zone.center_x + zone.scale_x * relative.x,
        zone.center_y + zone.scale_y * relative.y,
        zone.center_z + zone.scale_z * relative.z,
    )
}

/// Same as [`world_pos_from_zone_relative`] but clamps the resolved world
/// position into the `[-1, 1]` cube. Returns the clamped tuple plus
/// whether any axis was actually clamped — production callers should
/// prefer the `(center, scale, relative)`-based helpers in
/// `super::frame::resolve_zone_relative` /
/// `super::frame::resolve_zone_relative_clamped` which avoid coupling
/// to the `HueZone` struct. Kept here as a thin authoring-side wrapper
/// + a self-test of the formula equivalence.
#[cfg(test)]
pub fn world_pos_clamped(
    zone: &HueZone,
    relative: &ZoneRelativePosition,
) -> ((f64, f64, f64), bool) {
    let (x, y, z) = world_pos_from_zone_relative(zone, relative);
    let cx = x.clamp(-1.0, 1.0);
    let cy = y.clamp(-1.0, 1.0);
    let cz = z.clamp(-1.0, 1.0);
    let clamped = (cx - x).abs() > f64::EPSILON
        || (cy - y).abs() > f64::EPSILON
        || (cz - z).abs() > f64::EPSILON;
    ((cx, cy, cz), clamped)
}

// ---------------------------------------------------------------------------
// Command logic
// ---------------------------------------------------------------------------

/// Insert a freshly authored zone into the existing list. Validates the
/// zone shape, rejects duplicate ids, and enforces the per-area channel
/// cap by counting how many channels the zone references.
pub fn create_zone(req: CreateZoneRequest) -> ZoneCommandResult {
    let CreateZoneRequest {
        zone,
        mut existing_zones,
    } = req;

    if let Err(status) = validate_zone_shape(&zone) {
        return ZoneCommandResult {
            status,
            zones: existing_zones,
            channels: Vec::new(),
        };
    }

    if existing_zones.iter().any(|z| z.id == zone.id) {
        return ZoneCommandResult {
            status: CommandStatus {
                code: STATUS_ZONE_NOT_FOUND.to_string(),
                message: format!("Zone id `{}` already exists; use update instead.", zone.id),
                details: None,
            },
            zones: existing_zones,
            channels: Vec::new(),
        };
    }

    if zone.channel_indices.len() > HUE_AREA_CHANNEL_LIMIT {
        return ZoneCommandResult {
            status: CommandStatus {
                code: STATUS_ZONE_LIMIT_REACHED.to_string(),
                message: format!(
                    "Zone references {} channels but bridge area cap is {}.",
                    zone.channel_indices.len(),
                    HUE_AREA_CHANNEL_LIMIT
                ),
                details: None,
            },
            zones: existing_zones,
            channels: Vec::new(),
        };
    }

    existing_zones.push(zone.clone());
    ZoneCommandResult {
        status: CommandStatus {
            code: STATUS_ZONE_CREATED.to_string(),
            message: format!("Hue zone `{}` created.", zone.name),
            details: Some(zone.id.clone()),
        },
        zones: existing_zones,
        channels: Vec::new(),
    }
}

/// Replace an existing zone (matched by id) with the supplied draft.
pub fn update_zone(req: UpdateZoneRequest) -> ZoneCommandResult {
    let UpdateZoneRequest {
        zone,
        mut existing_zones,
    } = req;

    if let Err(status) = validate_zone_shape(&zone) {
        return ZoneCommandResult {
            status,
            zones: existing_zones,
            channels: Vec::new(),
        };
    }

    let Some(slot) = existing_zones.iter_mut().find(|z| z.id == zone.id) else {
        return ZoneCommandResult {
            status: CommandStatus {
                code: STATUS_ZONE_NOT_FOUND.to_string(),
                message: format!("No zone with id `{}` to update.", zone.id),
                details: None,
            },
            zones: existing_zones,
            channels: Vec::new(),
        };
    };

    if zone.channel_indices.len() > HUE_AREA_CHANNEL_LIMIT {
        return ZoneCommandResult {
            status: CommandStatus {
                code: STATUS_ZONE_LIMIT_REACHED.to_string(),
                message: format!(
                    "Zone references {} channels but bridge area cap is {}.",
                    zone.channel_indices.len(),
                    HUE_AREA_CHANNEL_LIMIT
                ),
                details: None,
            },
            zones: existing_zones,
            channels: Vec::new(),
        };
    }

    *slot = zone.clone();
    ZoneCommandResult {
        status: CommandStatus {
            code: STATUS_ZONE_UPDATED.to_string(),
            message: format!("Hue zone `{}` updated.", zone.name),
            details: Some(zone.id.clone()),
        },
        zones: existing_zones,
        channels: Vec::new(),
    }
}

/// Delete a zone and detach any channels that referenced it. Detached
/// channels keep their last-known absolute `x/y/z` (legacy mode).
pub fn delete_zone(req: DeleteZoneRequest) -> ZoneCommandResult {
    let DeleteZoneRequest {
        zone_id,
        mut existing_zones,
        mut channels,
    } = req;

    let before = existing_zones.len();
    existing_zones.retain(|z| z.id != zone_id);
    if existing_zones.len() == before {
        return ZoneCommandResult {
            status: CommandStatus {
                code: STATUS_ZONE_NOT_FOUND.to_string(),
                message: format!("No zone with id `{zone_id}` to delete."),
                details: None,
            },
            zones: existing_zones,
            channels,
        };
    }

    let mut detached = 0usize;
    for ch in channels.iter_mut() {
        if ch.zone_id.as_deref() == Some(zone_id.as_str()) {
            ch.zone_id = None;
            ch.zone_relative_position = None;
            detached += 1;
        }
    }

    ZoneCommandResult {
        status: CommandStatus {
            code: STATUS_ZONE_DELETED.to_string(),
            message: format!("Hue zone `{zone_id}` deleted; {detached} channel(s) detached."),
            details: Some(zone_id),
        },
        zones: existing_zones,
        channels,
    }
}

/// Attach (or detach) a channel from a zone. On attach we verify:
/// 1. Target zone exists.
/// 2. Channel's entertainment area matches the zone's area.
/// 3. Zone-relative position is supplied and inside `[-1, 1]^3`.
/// 4. Zone has not exceeded the bridge per-area channel cap.
pub fn assign_channel_to_zone(req: AssignChannelRequest) -> ZoneCommandResult {
    let AssignChannelRequest {
        channel_index,
        zone_id,
        zone_relative_position,
        entertainment_area_id,
        mut existing_zones,
        mut channels,
    } = req;

    // Detach branch — clears any zone reference on the channel.
    let Some(target_zone_id) = zone_id else {
        if let Some(ch) = channels
            .iter_mut()
            .find(|c| c.channel_index == channel_index)
        {
            ch.zone_id = None;
            ch.zone_relative_position = None;
        }
        // Drop the channel id from any zone that still references it.
        for zone in existing_zones.iter_mut() {
            zone.channel_indices.retain(|idx| *idx != channel_index);
        }
        return ZoneCommandResult {
            status: CommandStatus {
                code: STATUS_ZONE_UPDATED.to_string(),
                message: format!("Channel {channel_index} detached from zone."),
                details: None,
            },
            zones: existing_zones,
            channels,
        };
    };

    let Some(zone) = existing_zones.iter().find(|z| z.id == target_zone_id) else {
        return ZoneCommandResult {
            status: CommandStatus {
                code: STATUS_ZONE_NOT_FOUND.to_string(),
                message: format!("Target zone `{target_zone_id}` does not exist."),
                details: None,
            },
            zones: existing_zones,
            channels,
        };
    };

    if zone.entertainment_area_id != entertainment_area_id {
        return ZoneCommandResult {
            status: CommandStatus {
                code: STATUS_ZONE_CHANNEL_NOT_IN_AREA.to_string(),
                message: format!(
                    "Channel area `{}` does not match zone area `{}`.",
                    entertainment_area_id, zone.entertainment_area_id
                ),
                details: None,
            },
            zones: existing_zones,
            channels,
        };
    }

    let Some(rel) = zone_relative_position else {
        return ZoneCommandResult {
            status: CommandStatus {
                code: STATUS_ZONE_OUT_OF_BOUNDS.to_string(),
                message: "Zone-relative position is required when attaching a channel.".to_string(),
                details: None,
            },
            zones: existing_zones,
            channels,
        };
    };

    if !is_zone_relative_in_bounds(&rel) {
        let axis = out_of_bounds_axis(&rel);
        return ZoneCommandResult {
            status: CommandStatus {
                code: STATUS_ZONE_OUT_OF_BOUNDS.to_string(),
                message: format!("Zone-relative `{axis}` axis is outside [-1, 1]."),
                details: None,
            },
            zones: existing_zones,
            channels,
        };
    }

    // Capacity check: would this push the zone past the bridge area cap?
    let zone_idx = existing_zones
        .iter()
        .position(|z| z.id == target_zone_id)
        .expect("zone existence verified above");
    let zone_mut = &mut existing_zones[zone_idx];
    let already_in_zone = zone_mut.channel_indices.contains(&channel_index);
    if !already_in_zone && zone_mut.channel_indices.len() >= HUE_AREA_CHANNEL_LIMIT {
        return ZoneCommandResult {
            status: CommandStatus {
                code: STATUS_ZONE_LIMIT_REACHED.to_string(),
                message: format!(
                    "Zone `{}` already holds {} channels (bridge cap).",
                    zone_mut.id, HUE_AREA_CHANNEL_LIMIT
                ),
                details: None,
            },
            zones: existing_zones,
            channels,
        };
    }
    if !already_in_zone {
        zone_mut.channel_indices.push(channel_index);
    }

    // Detach this channel from any other zone first.
    for (i, zone) in existing_zones.iter_mut().enumerate() {
        if i != zone_idx {
            zone.channel_indices.retain(|idx| *idx != channel_index);
        }
    }

    if let Some(ch) = channels
        .iter_mut()
        .find(|c| c.channel_index == channel_index)
    {
        ch.zone_id = Some(target_zone_id.clone());
        ch.zone_relative_position = Some(rel);
    } else {
        // Frontend may not have a placement yet; synthesise one so the
        // zone reference persists. World coordinates are derived from the
        // zone's transform.
        let zone_ref = &existing_zones[zone_idx];
        let (wx, wy, wz) = world_pos_from_zone_relative(zone_ref, &rel);
        channels.push(HueChannelPlacement {
            channel_index,
            x: wx,
            y: wy,
            z: wz,
            label: None,
            zone_id: Some(target_zone_id.clone()),
            zone_relative_position: Some(rel),
        });
    }

    ZoneCommandResult {
        status: CommandStatus {
            code: STATUS_ZONE_UPDATED.to_string(),
            message: format!("Channel {channel_index} attached to zone `{target_zone_id}`."),
            details: Some(target_zone_id),
        },
        zones: existing_zones,
        channels,
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn make_zone(id: &str, area: &str, channels: Vec<u8>) -> HueZone {
        HueZone {
            id: id.to_string(),
            name: format!("Zone {id}"),
            entertainment_area_id: area.to_string(),
            center_x: 0.5,
            center_y: 0.5,
            center_z: 0.0,
            scale_x: 0.3,
            scale_y: 0.3,
            scale_z: 1.0,
            channel_indices: channels,
            border_color: None,
            center_color: None,
        }
    }

    #[test]
    fn world_pos_from_zone_relative_applies_center_plus_scaled_offset() {
        let zone = make_zone("z1", "area-1", vec![]);
        let rel = ZoneRelativePosition {
            x: 1.0,
            y: 1.0,
            z: 0.0,
        };
        let (x, y, z) = world_pos_from_zone_relative(&zone, &rel);
        assert!((x - 0.8).abs() < 1e-9, "expected x≈0.8, got {x}");
        assert!((y - 0.8).abs() < 1e-9, "expected y≈0.8, got {y}");
        assert!(z.abs() < 1e-9, "expected z≈0, got {z}");
    }

    #[test]
    fn world_pos_clamped_clips_to_unit_cube_and_signals_clamp() {
        // Center 0.9 + scale 0.5 * relative 1.0 = 1.4, outside [-1, 1].
        let mut zone = make_zone("z1", "area-1", vec![]);
        zone.center_x = 0.9;
        zone.scale_x = 0.5;
        let rel = ZoneRelativePosition {
            x: 1.0,
            y: 0.0,
            z: 0.0,
        };
        let ((x, _, _), clamped) = world_pos_clamped(&zone, &rel);
        assert!(clamped, "expected clamp signal");
        assert!((x - 1.0).abs() < 1e-9, "expected clamped x=1.0, got {x}");
    }

    #[test]
    fn create_zone_pushes_a_new_zone_and_returns_created_status() {
        let mut zone = make_zone("z1", "area-1", vec![0, 1]);
        // Recenter so |center| + scale stays inside the cube under the
        // new W4-C bounds invariant (0.5 + 0.3 = 0.8 ✓).
        zone.center_x = 0.5;
        zone.center_y = 0.5;
        let result = create_zone(CreateZoneRequest {
            zone: zone.clone(),
            existing_zones: Vec::new(),
        });
        assert_eq!(result.status.code, STATUS_ZONE_CREATED);
        assert_eq!(result.zones.len(), 1);
        assert_eq!(result.zones[0].id, zone.id);
    }

    #[test]
    fn create_zone_rejects_duplicate_ids() {
        let zone = make_zone("z1", "area-1", vec![]);
        let result = create_zone(CreateZoneRequest {
            zone: zone.clone(),
            existing_zones: vec![zone.clone()],
        });
        assert_eq!(result.status.code, STATUS_ZONE_NOT_FOUND);
        assert_eq!(result.zones.len(), 1);
    }

    #[test]
    fn create_zone_rejects_when_channel_count_exceeds_area_cap() {
        let zone = make_zone(
            "z1",
            "area-1",
            (0..(HUE_AREA_CHANNEL_LIMIT as u8 + 1)).collect(),
        );
        let result = create_zone(CreateZoneRequest {
            zone,
            existing_zones: Vec::new(),
        });
        assert_eq!(result.status.code, STATUS_ZONE_LIMIT_REACHED);
        assert!(result.zones.is_empty());
    }

    #[test]
    fn update_zone_replaces_an_existing_zone() {
        let original = make_zone("z1", "area-1", vec![0]);
        let mut updated = original.clone();
        updated.name = "Renamed".to_string();
        let result = update_zone(UpdateZoneRequest {
            zone: updated.clone(),
            existing_zones: vec![original],
        });
        assert_eq!(result.status.code, STATUS_ZONE_UPDATED);
        assert_eq!(result.zones[0].name, "Renamed");
    }

    #[test]
    fn update_zone_returns_not_found_for_unknown_id() {
        let zone = make_zone("ghost", "area-1", vec![]);
        let result = update_zone(UpdateZoneRequest {
            zone,
            existing_zones: Vec::new(),
        });
        assert_eq!(result.status.code, STATUS_ZONE_NOT_FOUND);
    }

    #[test]
    fn delete_zone_detaches_channels_referencing_it() {
        let zone = make_zone("z1", "area-1", vec![0]);
        let channel = HueChannelPlacement {
            channel_index: 0,
            x: 0.8,
            y: 0.8,
            z: 0.0,
            label: None,
            zone_id: Some("z1".to_string()),
            zone_relative_position: Some(ZoneRelativePosition {
                x: 1.0,
                y: 1.0,
                z: 0.0,
            }),
        };
        let result = delete_zone(DeleteZoneRequest {
            zone_id: "z1".to_string(),
            existing_zones: vec![zone],
            channels: vec![channel],
        });
        assert_eq!(result.status.code, STATUS_ZONE_DELETED);
        assert!(result.zones.is_empty());
        assert_eq!(result.channels.len(), 1);
        assert!(result.channels[0].zone_id.is_none());
        assert!(result.channels[0].zone_relative_position.is_none());
    }

    #[test]
    fn assign_channel_rejects_when_areas_do_not_match() {
        let zone = make_zone("z1", "area-1", vec![]);
        let result = assign_channel_to_zone(AssignChannelRequest {
            channel_index: 0,
            zone_id: Some("z1".to_string()),
            zone_relative_position: Some(ZoneRelativePosition {
                x: 0.0,
                y: 0.0,
                z: 0.0,
            }),
            entertainment_area_id: "area-2".to_string(),
            existing_zones: vec![zone],
            channels: Vec::new(),
        });
        assert_eq!(result.status.code, STATUS_ZONE_CHANNEL_NOT_IN_AREA);
    }

    #[test]
    fn assign_channel_rejects_when_relative_position_outside_unit_cube() {
        let zone = make_zone("z1", "area-1", vec![]);
        let result = assign_channel_to_zone(AssignChannelRequest {
            channel_index: 0,
            zone_id: Some("z1".to_string()),
            zone_relative_position: Some(ZoneRelativePosition {
                x: 1.5,
                y: 0.0,
                z: 0.0,
            }),
            entertainment_area_id: "area-1".to_string(),
            existing_zones: vec![zone],
            channels: Vec::new(),
        });
        assert_eq!(result.status.code, STATUS_ZONE_OUT_OF_BOUNDS);
    }

    #[test]
    fn assign_channel_attaches_and_records_zone_reference() {
        let zone = make_zone("z1", "area-1", vec![]);
        let result = assign_channel_to_zone(AssignChannelRequest {
            channel_index: 4,
            zone_id: Some("z1".to_string()),
            zone_relative_position: Some(ZoneRelativePosition {
                x: 0.5,
                y: -0.5,
                z: 0.0,
            }),
            entertainment_area_id: "area-1".to_string(),
            existing_zones: vec![zone],
            channels: Vec::new(),
        });
        assert_eq!(result.status.code, STATUS_ZONE_UPDATED);
        assert_eq!(result.zones[0].channel_indices, vec![4]);
        assert_eq!(result.channels.len(), 1);
        assert_eq!(result.channels[0].zone_id.as_deref(), Some("z1"));
    }

    #[test]
    fn assign_channel_detach_branch_clears_references() {
        let mut zone = make_zone("z1", "area-1", vec![2]);
        zone.channel_indices = vec![2];
        let placement = HueChannelPlacement {
            channel_index: 2,
            x: 0.0,
            y: 0.0,
            z: 0.0,
            label: None,
            zone_id: Some("z1".to_string()),
            zone_relative_position: Some(ZoneRelativePosition {
                x: 0.0,
                y: 0.0,
                z: 0.0,
            }),
        };
        let result = assign_channel_to_zone(AssignChannelRequest {
            channel_index: 2,
            zone_id: None,
            zone_relative_position: None,
            entertainment_area_id: "area-1".to_string(),
            existing_zones: vec![zone],
            channels: vec![placement],
        });
        assert_eq!(result.status.code, STATUS_ZONE_UPDATED);
        assert!(result.zones[0].channel_indices.is_empty());
        assert!(result.channels[0].zone_id.is_none());
    }

    // -----------------------------------------------------------------------
    // v1.5 W4-I — per-axis scale validation (no AR lock; physical 1:1 square)
    // -----------------------------------------------------------------------

    #[test]
    fn create_zone_rejects_oversized_scale_above_room_size() {
        // scale > 1.0 ⇒ zone bigger than the room. User spec: zone may
        // equal the room (`1.0`), never exceed it. Per-axis check.
        let mut zone = make_zone("z1", "area-1", vec![]);
        zone.center_x = 0.0;
        zone.center_y = 0.0;
        zone.scale_x = 1.5;
        zone.scale_y = 1.5;
        let result = create_zone(CreateZoneRequest {
            zone,
            existing_zones: Vec::new(),
        });
        assert_eq!(result.status.code, STATUS_ZONE_OVERSIZED);
        assert!(result.zones.is_empty());
    }

    #[test]
    fn create_zone_accepts_scale_equal_to_one_for_room_sized_zone() {
        // Exact equality `1.0` is the "zone == room" sweet spot the user
        // explicitly called out as legal. Centred at origin so
        // |center| + half-scale == 1.0 (boundary tolerated by tolerance).
        let mut zone = make_zone("z1", "area-1", vec![]);
        zone.center_x = 0.0;
        zone.center_y = 0.0;
        zone.scale_x = 1.0;
        zone.scale_y = 1.0;
        let result = create_zone(CreateZoneRequest {
            zone,
            existing_zones: Vec::new(),
        });
        assert_eq!(result.status.code, STATUS_ZONE_CREATED);
        assert_eq!(result.zones.len(), 1);
    }

    #[test]
    fn create_zone_rejects_below_floor_scale() {
        let mut zone = make_zone("z1", "area-1", vec![]);
        zone.center_x = 0.0;
        zone.center_y = 0.0;
        zone.scale_x = 0.01; // below HUE_ZONE_SCALE_MIN
        zone.scale_y = 0.01;
        let result = create_zone(CreateZoneRequest {
            zone,
            existing_zones: Vec::new(),
        });
        assert_eq!(result.status.code, STATUS_ZONE_OVERSIZED);
    }

    #[test]
    fn create_zone_accepts_asymmetric_scale_for_physical_metric_square() {
        // W4-I — a 2 m × 2 m physical square in a 5 m × 4 m room maps
        // to scale_x = 2/5 = 0.40 and scale_y = 2/4 = 0.50. The two
        // axes are intentionally unequal in cube space; the W4-C
        // uniform-AR lock is dropped. Each axis independently sits in
        // [MIN, MAX] so validation must accept the write.
        let mut zone = make_zone("z1", "area-1", vec![]);
        zone.center_x = 0.0;
        zone.center_y = 0.0;
        zone.scale_x = 0.4;
        zone.scale_y = 0.5;
        let result = create_zone(CreateZoneRequest {
            zone,
            existing_zones: Vec::new(),
        });
        assert_eq!(result.status.code, STATUS_ZONE_CREATED);
        assert_eq!(result.zones.len(), 1);
    }

    #[test]
    fn create_zone_rejects_when_only_one_axis_overflows() {
        // Asymmetric scale is fine, but each axis is still individually
        // bounded — `scale_x = 1.2` overflows even though `scale_y` is
        // legal. Defends the runtime sampler against half-broken writes.
        let mut zone = make_zone("z1", "area-1", vec![]);
        zone.center_x = 0.0;
        zone.center_y = 0.0;
        zone.scale_x = 1.2;
        zone.scale_y = 0.5;
        let result = create_zone(CreateZoneRequest {
            zone,
            existing_zones: Vec::new(),
        });
        assert_eq!(result.status.code, STATUS_ZONE_OVERSIZED);
    }

    #[test]
    fn create_zone_rejects_when_center_plus_half_scale_overflows_cube() {
        // center 0.7 + scale 0.5 = 1.2 ⇒ bounds escape the room.
        // Distinct from oversized (scale itself is in range) — caller
        // must shrink the zone OR drag the center back.
        let mut zone = make_zone("z1", "area-1", vec![]);
        zone.center_x = 0.7;
        zone.center_y = 0.0;
        zone.scale_x = 0.5;
        zone.scale_y = 0.5;
        let result = create_zone(CreateZoneRequest {
            zone,
            existing_zones: Vec::new(),
        });
        assert_eq!(result.status.code, STATUS_ZONE_OUT_OF_BOUNDS);
    }

    #[test]
    fn create_zone_rejects_non_finite_scale() {
        let mut zone = make_zone("z1", "area-1", vec![]);
        zone.scale_x = f64::NAN;
        let result = create_zone(CreateZoneRequest {
            zone,
            existing_zones: Vec::new(),
        });
        assert_eq!(result.status.code, STATUS_ZONE_OVERSIZED);
    }

    #[test]
    fn update_zone_rejects_oversized_scale() {
        // Pre-existing zone is valid; the update tries to grow scale
        // past 1.0. Must reject so the runtime sampler never sees a
        // bounds box that overflows the cube.
        let mut existing = make_zone("z1", "area-1", vec![]);
        existing.center_x = 0.0;
        existing.center_y = 0.0;
        existing.scale_x = 0.5;
        existing.scale_y = 0.5;
        let mut updated = existing.clone();
        updated.scale_x = 1.2;
        updated.scale_y = 1.2;
        let result = update_zone(UpdateZoneRequest {
            zone: updated,
            existing_zones: vec![existing.clone()],
        });
        assert_eq!(result.status.code, STATUS_ZONE_OVERSIZED);
        // Existing zone preserved unchanged on rejection.
        assert!((result.zones[0].scale_x - 0.5).abs() < 1e-9);
    }
}
