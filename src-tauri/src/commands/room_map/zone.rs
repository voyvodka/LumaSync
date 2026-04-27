//! Zone state machine (v1.5 W4-F — unified `Zone` covering both
//! `ZoneType::Logical` and `ZoneType::Hue`).
//!
//! Scope (v1.5 D2 + W4-F — locked):
//! - A zone is a UI / authoring concept that lives **inside one
//!   entertainment area** (when `zone_type == Hue`) or groups USB-side
//!   LEDs into a region (when `zone_type == Logical`). The bridge state
//!   machine is untouched, no multi-stream mux, no DTLS surface change.
//! - Hue channels keep their bridge-assigned `channel_index`. The Hue
//!   zone only provides a center+scale frame that the room-map editor
//!   uses to manipulate a subset of bulbs as a unit. Logical zones never
//!   own zone-relative coordinates — they are pure region grouping for
//!   the USB sampler.
//! - World-space resolution at frame-build time is `world = center +
//!   scale * zone_relative_position` and only fires for Hue zones. The
//!   transform helper lives here so callers (`commands::hue::frame`) can
//!   opt into zone awareness without re-deriving the math.
//!
//! Persistence: the canonical zone list lives in `RoomMapConfig.zones`
//! (unified `Zone[]`) on the frontend `shellStore`. These commands do
//! not persist on their own — the frontend round-trips the mutated
//! `RoomMapConfig` back to `save_room_map`. Each command therefore takes
//! the current `Vec<Zone>` (and, when relevant, `Vec<HueChannelPlacement>`)
//! as input and returns the mutated copy plus a `CommandStatus` carrying
//! a stable `ZONE_*` code from `src/shared/contracts/roomMap.ts`.

use serde::{Deserialize, Serialize};

use crate::commands::hue_onboarding::CommandStatus;
use crate::models::room_map::{HueChannelPlacement, Zone, ZoneRelativePosition, ZoneType};

// ---------------------------------------------------------------------------
// Constants & status codes
// ---------------------------------------------------------------------------

/// Bridge-side per-area channel cap (Hue Entertainment API v2.0). Mirrors
/// the limit advertised by `entertainment_configuration` resources. Used
/// to surface `ZONE_LIMIT_REACHED` when a Hue zone tries to grow past
/// what the area itself can accept. v1.5 W4-F: the cap is gated on
/// `zone_type == Hue` — logical zones have no bridge cap.
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
/// rejected while still catching real overflow.
const HUE_ZONE_BOUNDS_TOLERANCE: f64 = 1e-6;

const STATUS_ZONE_CREATED: &str = "ZONE_CREATED";
const STATUS_ZONE_UPDATED: &str = "ZONE_UPDATED";
const STATUS_ZONE_DELETED: &str = "ZONE_DELETED";
const STATUS_ZONE_NOT_FOUND: &str = "ZONE_NOT_FOUND";
const STATUS_ZONE_OUT_OF_BOUNDS: &str = "ZONE_CHANNEL_OUT_OF_BOUNDS";
const STATUS_ZONE_LIMIT_REACHED: &str = "ZONE_LIMIT_REACHED";
const STATUS_ZONE_CHANNEL_NOT_IN_AREA: &str = "ZONE_CHANNEL_NOT_IN_AREA";
/// Zone scale is outside `[HUE_ZONE_SCALE_MIN, HUE_ZONE_SCALE_MAX]` on
/// at least one axis, or non-finite. Distinct from
/// `ZONE_CHANNEL_OUT_OF_BOUNDS` (per-channel relative drift) because
/// the cause is a slider the user pulled past the room-equals-zone
/// ceiling — recovery is "shrink the zone", not "drag the channel back
/// inside". Only emitted for Hue zones (logical zones do not own
/// scale).
const STATUS_ZONE_OVERSIZED: &str = "ZONE_OVERSIZED";
/// v1.5 W4-F (new) — rejection when a `ZoneType::Hue` zone is missing
/// `entertainment_area_id` / center / scale, OR a `ZoneType::Logical`
/// zone carries Hue-only fields populated with non-default values.
/// Distinct from `ZONE_NOT_FOUND` (id resolution) — this is a
/// type-shape contract violation surfaced before the persist.
const STATUS_ZONE_TYPE_INVALID: &str = "ZONE_TYPE_INVALID";
/// v1.5 W4-F (new) — F4 "convert hue → logical" duplicate succeeded.
/// Status differs from `ZONE_CREATED` so the UI can show a
/// "duplicated as logical" toast distinct from the generic "zone added"
/// toast. Reserved for the F4 wire-up; not emitted by the four
/// authoring commands today (placeholder kept here so the contract
/// surface is whole and the drift guard sees the constant in source).
#[allow(dead_code)]
const STATUS_ZONE_CONVERSION_OK: &str = "ZONE_CONVERSION_OK";

// ---------------------------------------------------------------------------
// Request / response payloads
// ---------------------------------------------------------------------------

/// Request payload for `create_zone`. The frontend sends the active
/// `RoomMapConfig.zones` along with the new zone draft so the command
/// can validate uniqueness without persisting state itself.
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CreateZoneRequest {
    pub zone: Zone,
    #[serde(default)]
    pub existing_zones: Vec<Zone>,
}

/// Request payload for `update_zone`. The mutated zone is matched by
/// `zone.id`; a missing match yields `ZONE_NOT_FOUND`.
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UpdateZoneRequest {
    pub zone: Zone,
    #[serde(default)]
    pub existing_zones: Vec<Zone>,
}

/// Request payload for `delete_zone`. Channels referencing the deleted
/// zone fall back to legacy absolute placement (`zone_id` cleared).
/// Logical zones never owned `zone_relative_position`, so the field stays
/// untouched on detach for them — only the `zone_id` reference clears.
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DeleteZoneRequest {
    pub zone_id: String,
    #[serde(default)]
    pub existing_zones: Vec<Zone>,
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
    /// Required when the target zone is a Hue zone; ignored for logical
    /// zones (which do not own zone-relative coordinates) and on detach.
    pub zone_relative_position: Option<ZoneRelativePosition>,
    /// Entertainment area id of the channel — must match the target
    /// zone's `entertainment_area_id` when the zone is a Hue zone, else
    /// `ZONE_CHANNEL_NOT_IN_AREA`. Logical zones have no
    /// `entertainment_area_id`, so the area check is skipped entirely.
    pub entertainment_area_id: String,
    #[serde(default)]
    pub existing_zones: Vec<Zone>,
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
    pub zones: Vec<Zone>,
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

/// v1.5 W4-F — zone-type-shape contract enforcement. Runs before any
/// shape-specific validation so a malformed Hue / Logical write fails
/// fast with `ZONE_TYPE_INVALID` instead of confusing the caller with a
/// downstream bounds error.
///
/// - `ZoneType::Hue` MUST populate `entertainment_area_id` (non-empty
///   trimmed string), `center_*`, and `scale_*` (all axes).
/// - `ZoneType::Logical` MUST keep all Hue-only fields `None` — defends
///   against a frontend bug that copies a Hue zone but forgets to clear
///   the center/scale tuple.
fn validate_zone_type_shape(zone: &Zone) -> Result<(), CommandStatus> {
    match zone.zone_type {
        ZoneType::Hue => {
            let has_area = zone
                .entertainment_area_id
                .as_deref()
                .map(|s| !s.trim().is_empty())
                .unwrap_or(false);
            let has_center =
                zone.center_x.is_some() && zone.center_y.is_some() && zone.center_z.is_some();
            let has_scale =
                zone.scale_x.is_some() && zone.scale_y.is_some() && zone.scale_z.is_some();
            if !has_area || !has_center || !has_scale {
                return Err(CommandStatus {
                    code: STATUS_ZONE_TYPE_INVALID.to_string(),
                    message: "Hue zone must populate entertainmentAreaId, center{X,Y,Z}, \
                              and scale{X,Y,Z}."
                        .to_string(),
                    details: None,
                });
            }
        }
        ZoneType::Logical => {
            let leaks_area = zone
                .entertainment_area_id
                .as_deref()
                .map(|s| !s.trim().is_empty())
                .unwrap_or(false);
            let leaks_center =
                zone.center_x.is_some() || zone.center_y.is_some() || zone.center_z.is_some();
            let leaks_scale =
                zone.scale_x.is_some() || zone.scale_y.is_some() || zone.scale_z.is_some();
            if leaks_area || leaks_center || leaks_scale {
                return Err(CommandStatus {
                    code: STATUS_ZONE_TYPE_INVALID.to_string(),
                    message: "Logical zone must NOT carry Hue-only fields \
                              (entertainmentAreaId / center / scale)."
                        .to_string(),
                    details: None,
                });
            }
        }
    }
    Ok(())
}

fn zone_center_in_bounds(zone: &Zone) -> bool {
    let cx = zone.center_x.unwrap_or(0.0);
    let cy = zone.center_y.unwrap_or(0.0);
    let cz = zone.center_z.unwrap_or(0.0);
    in_unit_range(cx) && in_unit_range(cy) && in_unit_range(cz)
}

/// Validate a zone draft. Branches on `zone.zone_type`:
/// - `ZoneType::Logical` — only id/name non-empty + the zone-type-shape
///   contract (Hue-only fields MUST be absent).
/// - `ZoneType::Hue` — full body: cube bounds + per-axis scale clamps +
///   non-empty `entertainment_area_id`.
fn validate_zone_shape(zone: &Zone) -> Result<(), CommandStatus> {
    if zone.id.trim().is_empty() {
        return Err(CommandStatus {
            code: STATUS_ZONE_TYPE_INVALID.to_string(),
            message: "Zone id must be non-empty.".to_string(),
            details: None,
        });
    }
    if zone.name.trim().is_empty() {
        return Err(CommandStatus {
            code: STATUS_ZONE_TYPE_INVALID.to_string(),
            message: "Zone name must be non-empty.".to_string(),
            details: None,
        });
    }

    // Type-shape contract first — surfaces ZONE_TYPE_INVALID for both
    // missing-Hue-fields and logical-leaks-Hue-fields cases. After this
    // check the Hue branch can safely unwrap the Hue-only fields.
    validate_zone_type_shape(zone)?;

    if zone.zone_type == ZoneType::Logical {
        // Logical zones do not own center / scale / area; only the
        // identity fields are validated. Channel cap is gated on
        // `zone_type == Hue` in create_zone / update_zone so a logical
        // zone with > 10 channels (e.g. a 60-LED USB strip region) is
        // accepted.
        return Ok(());
    }

    // ── ZoneType::Hue branch ───────────────────────────────────────────
    if !zone_center_in_bounds(zone) {
        return Err(CommandStatus {
            code: STATUS_ZONE_OUT_OF_BOUNDS.to_string(),
            message: "Zone center must lie within the [-1, 1] cube.".to_string(),
            details: None,
        });
    }

    let sx = zone.scale_x.unwrap_or(0.0);
    let sy = zone.scale_y.unwrap_or(0.0);
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
    // bounds box never overflows the Hue cube.
    let half_x = sx;
    let half_y = sy;
    let cx = zone.center_x.unwrap_or(0.0);
    let cy = zone.center_y.unwrap_or(0.0);
    if cx.abs() + half_x > 1.0 + HUE_ZONE_BOUNDS_TOLERANCE
        || cy.abs() + half_y > 1.0 + HUE_ZONE_BOUNDS_TOLERANCE
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

/// Resolve a zone-relative position into world space for a Hue zone.
/// `world.x = center.x + scale.x * relative.x` (and analogously y, z).
///
/// Logical zones never own zone-relative coordinates; calling this on a
/// logical zone returns the channel's untransformed relative coordinates
/// because the Hue-only `center/scale` fields are `None` (treated as 0
/// and 1 respectively). Production callers MUST gate on
/// `zone.zone_type == Hue` before invoking this helper — see RFC §2.4.
pub fn world_pos_from_zone_relative(
    zone: &Zone,
    relative: &ZoneRelativePosition,
) -> (f64, f64, f64) {
    let cx = zone.center_x.unwrap_or(0.0);
    let cy = zone.center_y.unwrap_or(0.0);
    let cz = zone.center_z.unwrap_or(0.0);
    let sx = zone.scale_x.unwrap_or(1.0);
    let sy = zone.scale_y.unwrap_or(1.0);
    let sz = zone.scale_z.unwrap_or(1.0);
    (
        cx + sx * relative.x,
        cy + sy * relative.y,
        cz + sz * relative.z,
    )
}

/// Same as [`world_pos_from_zone_relative`] but clamps the resolved world
/// position into the `[-1, 1]` cube. Returns the clamped tuple plus
/// whether any axis was actually clamped — production callers should
/// prefer the `(center, scale, relative)`-based helpers in
/// `super::super::hue::frame::resolve_zone_relative` /
/// `super::super::hue::frame::resolve_zone_relative_clamped` which avoid
/// coupling to the `Zone` struct. Kept here as a thin authoring-side
/// wrapper + a self-test of the formula equivalence.
#[cfg(test)]
pub fn world_pos_clamped(zone: &Zone, relative: &ZoneRelativePosition) -> ((f64, f64, f64), bool) {
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
/// zone shape (branches on `zone_type`), rejects duplicate ids, and —
/// only for Hue zones — enforces the per-area channel cap by counting
/// how many channels the zone references. Logical zones have no bridge
/// cap (a 60-LED USB strip's logical region zone is legal).
#[tauri::command]
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

    if zone.zone_type == ZoneType::Hue && zone.channel_indices.len() > HUE_AREA_CHANNEL_LIMIT {
        return ZoneCommandResult {
            status: CommandStatus {
                code: STATUS_ZONE_LIMIT_REACHED.to_string(),
                message: format!(
                    "Hue zone references {} channels but bridge area cap is {}.",
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
            message: format!("Zone `{}` created.", zone.name),
            details: Some(zone.id.clone()),
        },
        zones: existing_zones,
        channels: Vec::new(),
    }
}

/// Replace an existing zone (matched by id) with the supplied draft.
#[tauri::command]
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

    if zone.zone_type == ZoneType::Hue && zone.channel_indices.len() > HUE_AREA_CHANNEL_LIMIT {
        return ZoneCommandResult {
            status: CommandStatus {
                code: STATUS_ZONE_LIMIT_REACHED.to_string(),
                message: format!(
                    "Hue zone references {} channels but bridge area cap is {}.",
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
            message: format!("Zone `{}` updated.", zone.name),
            details: Some(zone.id.clone()),
        },
        zones: existing_zones,
        channels: Vec::new(),
    }
}

/// Delete a zone and detach any channels that referenced it.
///
/// - Hue zones: detached channels keep their last-known absolute `x/y/z`
///   (legacy mode); both `zone_id` and `zone_relative_position` are
///   cleared.
/// - Logical zones: only `zone_id` clears (logical zones never owned
///   `zone_relative_position`, so we leave it untouched if it somehow
///   still carries a value from a stale write).
#[tauri::command]
pub fn delete_zone(req: DeleteZoneRequest) -> ZoneCommandResult {
    let DeleteZoneRequest {
        zone_id,
        mut existing_zones,
        mut channels,
    } = req;

    let Some(target_idx) = existing_zones.iter().position(|z| z.id == zone_id) else {
        return ZoneCommandResult {
            status: CommandStatus {
                code: STATUS_ZONE_NOT_FOUND.to_string(),
                message: format!("No zone with id `{zone_id}` to delete."),
                details: None,
            },
            zones: existing_zones,
            channels,
        };
    };
    let target_type = existing_zones[target_idx].zone_type;
    existing_zones.remove(target_idx);

    let mut detached = 0usize;
    for ch in channels.iter_mut() {
        if ch.zone_id.as_deref() == Some(zone_id.as_str()) {
            ch.zone_id = None;
            // Logical zones never owned zone-relative coordinates, so
            // leave that field untouched. Hue zones do — clear both.
            if target_type == ZoneType::Hue {
                ch.zone_relative_position = None;
            }
            detached += 1;
        }
    }

    ZoneCommandResult {
        status: CommandStatus {
            code: STATUS_ZONE_DELETED.to_string(),
            message: format!("Zone `{zone_id}` deleted; {detached} channel(s) detached."),
            details: Some(zone_id),
        },
        zones: existing_zones,
        channels,
    }
}

/// Attach (or detach) a channel from a zone. On attach we verify:
/// 1. Target zone exists.
/// 2. (Hue zone only) Channel's entertainment area matches the zone's
///    area. Logical zones have no `entertainment_area_id`, so the area
///    check is skipped.
/// 3. (Hue zone only) Zone-relative position is supplied and inside
///    `[-1, 1]^3`. Logical zones do not own zone-relative coordinates.
/// 4. (Hue zone only) Zone has not exceeded the bridge per-area channel
///    cap. Logical zones have no bridge cap.
#[tauri::command]
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

    let target_type = zone.zone_type;

    // Hue zones enforce both area parity and a zone-relative position.
    // Logical zones skip both checks — they are pure region grouping.
    if target_type == ZoneType::Hue {
        let zone_area = zone.entertainment_area_id.as_deref().unwrap_or("");
        if zone_area != entertainment_area_id {
            return ZoneCommandResult {
                status: CommandStatus {
                    code: STATUS_ZONE_CHANNEL_NOT_IN_AREA.to_string(),
                    message: format!(
                        "Channel area `{entertainment_area_id}` does not match zone area \
                         `{zone_area}`.",
                    ),
                    details: None,
                },
                zones: existing_zones,
                channels,
            };
        }
    }

    let mut resolved_relative: Option<ZoneRelativePosition> = None;
    if target_type == ZoneType::Hue {
        let Some(rel) = zone_relative_position else {
            return ZoneCommandResult {
                status: CommandStatus {
                    code: STATUS_ZONE_OUT_OF_BOUNDS.to_string(),
                    message: "Zone-relative position is required when attaching a channel \
                              to a Hue zone."
                        .to_string(),
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
        resolved_relative = Some(rel);
    }

    // Capacity check — Hue-only. Logical zones never trip the bridge
    // per-area cap because they have no bridge.
    let zone_idx = existing_zones
        .iter()
        .position(|z| z.id == target_zone_id)
        .expect("zone existence verified above");
    let zone_mut = &mut existing_zones[zone_idx];
    let already_in_zone = zone_mut.channel_indices.contains(&channel_index);
    if !already_in_zone
        && target_type == ZoneType::Hue
        && zone_mut.channel_indices.len() >= HUE_AREA_CHANNEL_LIMIT
    {
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
        // Hue zone: write-through the resolved relative position.
        // Logical zone: clear any stale relative position the channel
        // may have carried from a previous Hue-zone membership.
        ch.zone_relative_position = resolved_relative.clone();
    } else if target_type == ZoneType::Hue {
        // Frontend may not have a placement yet — synthesise one so the
        // zone reference persists. World coordinates derive from the
        // zone's transform. Only meaningful for Hue zones; logical
        // zones never owned zone-relative coordinates, so we skip
        // synthesising a placeholder for them.
        let zone_ref = &existing_zones[zone_idx];
        let rel = resolved_relative
            .clone()
            .expect("Hue branch validated zone_relative_position above");
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

    fn make_hue_zone(id: &str, area: &str, channels: Vec<u8>) -> Zone {
        Zone {
            id: id.to_string(),
            name: format!("Zone {id}"),
            zone_type: ZoneType::Hue,
            channel_indices: channels,
            entertainment_area_id: Some(area.to_string()),
            center_x: Some(0.5),
            center_y: Some(0.5),
            center_z: Some(0.0),
            scale_x: Some(0.3),
            scale_y: Some(0.3),
            scale_z: Some(1.0),
            region: None,
            border_color: None,
            center_color: None,
        }
    }

    fn make_logical_zone(id: &str, channels: Vec<u8>) -> Zone {
        Zone {
            id: id.to_string(),
            name: format!("Zone {id}"),
            zone_type: ZoneType::Logical,
            channel_indices: channels,
            entertainment_area_id: None,
            center_x: None,
            center_y: None,
            center_z: None,
            scale_x: None,
            scale_y: None,
            scale_z: None,
            region: None,
            border_color: None,
            center_color: None,
        }
    }

    #[test]
    fn world_pos_from_zone_relative_applies_center_plus_scaled_offset() {
        let zone = make_hue_zone("z1", "area-1", vec![]);
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
        let mut zone = make_hue_zone("z1", "area-1", vec![]);
        zone.center_x = Some(0.9);
        zone.scale_x = Some(0.5);
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
        let mut zone = make_hue_zone("z1", "area-1", vec![0, 1]);
        zone.center_x = Some(0.5);
        zone.center_y = Some(0.5);
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
        let zone = make_hue_zone("z1", "area-1", vec![]);
        let result = create_zone(CreateZoneRequest {
            zone: zone.clone(),
            existing_zones: vec![zone.clone()],
        });
        assert_eq!(result.status.code, STATUS_ZONE_NOT_FOUND);
        assert_eq!(result.zones.len(), 1);
    }

    #[test]
    fn create_zone_rejects_when_channel_count_exceeds_area_cap() {
        let zone = make_hue_zone(
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
        let original = make_hue_zone("z1", "area-1", vec![0]);
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
        let zone = make_hue_zone("ghost", "area-1", vec![]);
        let result = update_zone(UpdateZoneRequest {
            zone,
            existing_zones: Vec::new(),
        });
        assert_eq!(result.status.code, STATUS_ZONE_NOT_FOUND);
    }

    #[test]
    fn delete_zone_detaches_channels_referencing_it() {
        let zone = make_hue_zone("z1", "area-1", vec![0]);
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
        let zone = make_hue_zone("z1", "area-1", vec![]);
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
        let zone = make_hue_zone("z1", "area-1", vec![]);
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
        let zone = make_hue_zone("z1", "area-1", vec![]);
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
        let mut zone = make_hue_zone("z1", "area-1", vec![2]);
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
        let mut zone = make_hue_zone("z1", "area-1", vec![]);
        zone.center_x = Some(0.0);
        zone.center_y = Some(0.0);
        zone.scale_x = Some(1.5);
        zone.scale_y = Some(1.5);
        let result = create_zone(CreateZoneRequest {
            zone,
            existing_zones: Vec::new(),
        });
        assert_eq!(result.status.code, STATUS_ZONE_OVERSIZED);
        assert!(result.zones.is_empty());
    }

    #[test]
    fn create_zone_accepts_scale_equal_to_one_for_room_sized_zone() {
        let mut zone = make_hue_zone("z1", "area-1", vec![]);
        zone.center_x = Some(0.0);
        zone.center_y = Some(0.0);
        zone.scale_x = Some(1.0);
        zone.scale_y = Some(1.0);
        let result = create_zone(CreateZoneRequest {
            zone,
            existing_zones: Vec::new(),
        });
        assert_eq!(result.status.code, STATUS_ZONE_CREATED);
        assert_eq!(result.zones.len(), 1);
    }

    #[test]
    fn create_zone_rejects_below_floor_scale() {
        let mut zone = make_hue_zone("z1", "area-1", vec![]);
        zone.center_x = Some(0.0);
        zone.center_y = Some(0.0);
        zone.scale_x = Some(0.01); // below HUE_ZONE_SCALE_MIN
        zone.scale_y = Some(0.01);
        let result = create_zone(CreateZoneRequest {
            zone,
            existing_zones: Vec::new(),
        });
        assert_eq!(result.status.code, STATUS_ZONE_OVERSIZED);
    }

    #[test]
    fn create_zone_accepts_asymmetric_scale_for_physical_metric_square() {
        let mut zone = make_hue_zone("z1", "area-1", vec![]);
        zone.center_x = Some(0.0);
        zone.center_y = Some(0.0);
        zone.scale_x = Some(0.4);
        zone.scale_y = Some(0.5);
        let result = create_zone(CreateZoneRequest {
            zone,
            existing_zones: Vec::new(),
        });
        assert_eq!(result.status.code, STATUS_ZONE_CREATED);
        assert_eq!(result.zones.len(), 1);
    }

    #[test]
    fn create_zone_rejects_when_only_one_axis_overflows() {
        let mut zone = make_hue_zone("z1", "area-1", vec![]);
        zone.center_x = Some(0.0);
        zone.center_y = Some(0.0);
        zone.scale_x = Some(1.2);
        zone.scale_y = Some(0.5);
        let result = create_zone(CreateZoneRequest {
            zone,
            existing_zones: Vec::new(),
        });
        assert_eq!(result.status.code, STATUS_ZONE_OVERSIZED);
    }

    #[test]
    fn create_zone_rejects_when_center_plus_half_scale_overflows_cube() {
        let mut zone = make_hue_zone("z1", "area-1", vec![]);
        zone.center_x = Some(0.7);
        zone.center_y = Some(0.0);
        zone.scale_x = Some(0.5);
        zone.scale_y = Some(0.5);
        let result = create_zone(CreateZoneRequest {
            zone,
            existing_zones: Vec::new(),
        });
        assert_eq!(result.status.code, STATUS_ZONE_OUT_OF_BOUNDS);
    }

    #[test]
    fn create_zone_rejects_non_finite_scale() {
        let mut zone = make_hue_zone("z1", "area-1", vec![]);
        zone.scale_x = Some(f64::NAN);
        let result = create_zone(CreateZoneRequest {
            zone,
            existing_zones: Vec::new(),
        });
        assert_eq!(result.status.code, STATUS_ZONE_OVERSIZED);
    }

    #[test]
    fn update_zone_rejects_oversized_scale() {
        let mut existing = make_hue_zone("z1", "area-1", vec![]);
        existing.center_x = Some(0.0);
        existing.center_y = Some(0.0);
        existing.scale_x = Some(0.5);
        existing.scale_y = Some(0.5);
        let mut updated = existing.clone();
        updated.scale_x = Some(1.2);
        updated.scale_y = Some(1.2);
        let result = update_zone(UpdateZoneRequest {
            zone: updated,
            existing_zones: vec![existing.clone()],
        });
        assert_eq!(result.status.code, STATUS_ZONE_OVERSIZED);
        assert!((result.zones[0].scale_x.unwrap() - 0.5).abs() < 1e-9);
    }

    // -----------------------------------------------------------------------
    // v1.5 W4-F — Zone unification (logical vs Hue) discriminator coverage
    // -----------------------------------------------------------------------

    #[test]
    fn create_zone_logical_does_not_require_hue_fields() {
        // Logical zone with all Hue-only fields cleared. Should pass
        // validation cleanly even though entertainmentAreaId / center /
        // scale are None.
        let zone = make_logical_zone("z-logical", vec![0, 1, 2]);
        let result = create_zone(CreateZoneRequest {
            zone: zone.clone(),
            existing_zones: Vec::new(),
        });
        assert_eq!(result.status.code, STATUS_ZONE_CREATED);
        assert_eq!(result.zones.len(), 1);
        assert_eq!(result.zones[0].zone_type, ZoneType::Logical);
        assert!(result.zones[0].entertainment_area_id.is_none());
        assert!(result.zones[0].center_x.is_none());
        assert!(result.zones[0].scale_x.is_none());
    }

    #[test]
    fn create_zone_hue_missing_entertainment_area_returns_type_invalid() {
        // Hue zone draft with the area id stripped — type-shape contract
        // violation, surfaced before any cube-bounds check.
        let mut zone = make_hue_zone("z-hue", "area-1", vec![]);
        zone.entertainment_area_id = None;
        let result = create_zone(CreateZoneRequest {
            zone,
            existing_zones: Vec::new(),
        });
        assert_eq!(result.status.code, STATUS_ZONE_TYPE_INVALID);
        assert!(result.zones.is_empty());
    }

    #[test]
    fn create_zone_logical_with_populated_hue_fields_returns_type_invalid() {
        // Frontend bug shape — copy-paste of a Hue zone that flipped
        // zone_type to Logical but forgot to clear centerX. Must reject
        // so the runtime sampler never sees a logical zone with Hue-only
        // bookkeeping.
        let mut zone = make_logical_zone("z-leak", vec![]);
        zone.center_x = Some(0.5);
        let result = create_zone(CreateZoneRequest {
            zone,
            existing_zones: Vec::new(),
        });
        assert_eq!(result.status.code, STATUS_ZONE_TYPE_INVALID);
        assert!(result.zones.is_empty());
    }

    #[test]
    fn assign_channel_to_logical_zone_skips_area_check() {
        // Logical zones have no entertainment_area_id, so the Hue-side
        // ZONE_CHANNEL_NOT_IN_AREA check must NOT fire — even when the
        // caller passes an arbitrary area id. Channel attaches cleanly.
        let zone = make_logical_zone("z-logical", vec![]);
        let result = assign_channel_to_zone(AssignChannelRequest {
            channel_index: 7,
            zone_id: Some("z-logical".to_string()),
            zone_relative_position: None,
            entertainment_area_id: "ignored-area".to_string(),
            existing_zones: vec![zone],
            channels: Vec::new(),
        });
        assert_eq!(result.status.code, STATUS_ZONE_UPDATED);
        assert_eq!(result.zones[0].channel_indices, vec![7]);
    }

    #[test]
    fn delete_logical_zone_does_not_touch_hue_channels() {
        // A channel that points at a logical zone should clear its
        // zone_id reference on logical-zone delete, but its
        // zone_relative_position (which a logical zone never owned)
        // stays untouched. A separately-scoped Hue placement on a
        // different channel must not be disturbed.
        let logical = make_logical_zone("z-logical", vec![5]);
        let logical_channel = HueChannelPlacement {
            channel_index: 5,
            x: 0.0,
            y: 0.0,
            z: 0.0,
            label: None,
            zone_id: Some("z-logical".to_string()),
            // zone_relative_position is None for logical zone members,
            // but if it were Some(_) (legacy stale write) the delete
            // path must NOT clear it because logical zones never owned
            // that field.
            zone_relative_position: None,
        };
        let result = delete_zone(DeleteZoneRequest {
            zone_id: "z-logical".to_string(),
            existing_zones: vec![logical],
            channels: vec![logical_channel],
        });
        assert_eq!(result.status.code, STATUS_ZONE_DELETED);
        assert!(result.zones.is_empty());
        assert!(result.channels[0].zone_id.is_none());
        // zone_relative_position untouched (was None, stays None).
        assert!(result.channels[0].zone_relative_position.is_none());
    }

    #[test]
    fn bridge_cap_only_applies_to_hue_zones() {
        // Twelve-channel logical zone: legal — logical zones have no
        // bridge cap, so a 60-LED USB strip's region grouping is fine.
        let logical = make_logical_zone("z-logical", (0..12).collect());
        let logical_result = create_zone(CreateZoneRequest {
            zone: logical,
            existing_zones: Vec::new(),
        });
        assert_eq!(logical_result.status.code, STATUS_ZONE_CREATED);

        // Twelve-channel Hue zone: ZONE_LIMIT_REACHED (bridge cap is 10).
        let mut hue = make_hue_zone("z-hue", "area-1", (0..12).collect());
        hue.center_x = Some(0.0);
        hue.center_y = Some(0.0);
        let hue_result = create_zone(CreateZoneRequest {
            zone: hue,
            existing_zones: Vec::new(),
        });
        assert_eq!(hue_result.status.code, STATUS_ZONE_LIMIT_REACHED);
    }
}
