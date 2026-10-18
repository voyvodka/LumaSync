import type { HueChannelPlacement, HueZone, RoomDimensions, RoomMapConfig } from "@/shared/contracts/roomMap";

import { ZONE_SCALE_MIN, zoneEdgeBounds } from "./zoneRect";

// A Hue zone is a cube in metres: one edge on all three sides, so each axis's Hue scale is that edge
// over its own side of the room. The bridge's [-1, 1] cube is stretched to the room, so a cube in Hue
// units drew as a flat box.

type Dims = Pick<RoomDimensions, "widthMeters" | "depthMeters" | "heightMeters">;

// Metres: scale × side drifts by ~1e-7 through JSON and f32, and a tighter test rewrote every load.
const SAME_M = 1e-3;
const AXES = ["X", "Y", "Z"] as const;
type Axis = (typeof AXES)[number];

const unit = (v: number) => (Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0);
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const sideOf = (a: Axis, d: Dims) => (a === "X" ? d.widthMeters : a === "Y" ? d.depthMeters : d.heightMeters);
const validDims = (d: Dims | undefined): d is Dims =>
  !!d && [d.widthMeters, d.depthMeters, d.heightMeters].every((v) => Number.isFinite(v) && v > 0);

export function zoneEdge(zone: Pick<HueZone, "scaleX">, d: Dims): number {
  return Math.abs(zone.scaleX) * d.widthMeters;
}

function scalesFor(edge: number, d: Dims): Record<Axis, number> {
  const { min, max } = zoneEdgeBounds(d.widthMeters, d.depthMeters, d.heightMeters);
  const e = clamp(Number.isFinite(edge) ? edge : min, min, max);
  return { X: clamp(e / d.widthMeters, ZONE_SCALE_MIN, 1), Y: clamp(e / d.depthMeters, ZONE_SCALE_MIN, 1), Z: clamp(e / d.heightMeters, ZONE_SCALE_MIN, 1) };
}

export function withCubeEdge(zone: HueZone, edge: number, d: Dims, centre: { x: number; y: number; z: number } = { x: zone.centerX, y: zone.centerY, z: zone.centerZ }): HueZone {
  const s = scalesFor(edge, d);
  return {
    ...zone,
    scaleX: s.X,
    scaleY: s.Y,
    scaleZ: s.Z,
    centerX: clamp(centre.x, s.X - 1, 1 - s.X),
    centerY: clamp(centre.y, s.Y - 1, 1 - s.Y),
    centerZ: clamp(centre.z, s.Z - 1, 1 - s.Z),
  };
}

export function isCubeZone(zone: HueZone, d: Dims): boolean {
  if (!finiteZone(zone)) return false;
  const cube = withCubeEdge(zone, zoneEdge(zone, d), d);
  return AXES.every(
    (a) => Math.abs(zone[`scale${a}`] - cube[`scale${a}`]) * sideOf(a, d) <= SAME_M && Math.abs(zone[`center${a}`] - cube[`center${a}`]) * sideOf(a, d) <= SAME_M,
  );
}

/** The largest edge that still fits round the zone's centre: the dock grows it about its centre. */
export function maxZoneEdgeAt(zone: Pick<HueZone, "centerX" | "centerY" | "centerZ">, d: Dims): number {
  const { min, max } = zoneEdgeBounds(d.widthMeters, d.depthMeters, d.heightMeters);
  return clamp(Math.min(...AXES.map((a) => (1 - Math.abs(zone[`center${a}`])) * sideOf(a, d))), min, max);
}

/** A grip pulled at the floor resizes from the floor, not about the centre. */
export function bottomKeptCenterZ(zone: Pick<HueZone, "centerZ" | "scaleZ">, edge: number, d: Dims): number {
  const s = scalesFor(edge, d).Z;
  return clamp(zone.centerZ - Math.abs(zone.scaleZ) + s, s - 1, 1 - s);
}

type Room = Pick<RoomMapConfig, "zones" | "hueChannels" | "dimensions">;

/**
 * Every zone made a cube in metres, each bound light kept where it resolved: the cube grows to cover
 * them up to the ceiling, and a light it still cannot hold leaves the zone where it stood. Clipping it
 * instead would move the light on the bridge. Idempotent. A zone already a cube, one with a non-finite
 * field, or a room without real dimensions is left as it is. Lights bind to the first zone with their
 * id, as both resolvers find it. `measuredIn` is the room a zone's size is read in: the one before a
 * resize or a template, so its edge survives the change.
 */
export function cubeZones<T extends Room>(room: T, measuredIn: Dims = room.dimensions): T {
  const d = room.dimensions;
  const zones = room.zones ?? [];
  // A room grown evenly leaves a cube a cube, but not its edge in metres.
  const settled = (z: HueZone) => isCubeZone(z, d) && Math.abs(zoneEdge(z, d) - zoneEdge(z, measuredIn)) <= SAME_M;
  if (!validDims(d) || !validDims(measuredIn) || zones.every((z) => !finiteZone(z) || settled(z))) return room;
  const channels = room.hueChannels ?? [];
  const firstWithId = new Map<string, HueZone>();
  for (const zone of zones) if (!firstWithId.has(zone.id)) firstWithId.set(zone.id, zone);
  const cubed = new Map<HueZone, HueZone>();
  for (const zone of firstWithId.values()) {
    if (!finiteZone(zone) || settled(zone)) continue;
    const bound = channels.filter((ch) => ch.zoneId === zone.id && ch.zoneRelativePosition);
    cubed.set(zone, toCube(zone, bound.map((ch) => worldOf(ch, zone)), d, measuredIn));
  }
  if (cubed.size === 0) return room;
  const left = new Map<string, Set<number>>();
  const hueChannels = channels.map((ch) => {
    const from = ch.zoneId ? firstWithId.get(ch.zoneId) : undefined;
    const to = from ? cubed.get(from) : undefined;
    if (!from || !to || !ch.zoneRelativePosition) return ch;
    const world = worldOf(ch, from);
    const rel = { x: (world.x - to.centerX) / to.scaleX, y: (world.y - to.centerY) / to.scaleY, z: (world.z - to.centerZ) / to.scaleZ };
    if ([rel.x, rel.y, rel.z].some((v) => Math.abs(v) > 1 + 1e-9)) {
      const gone = left.get(from.id) ?? new Set<number>();
      gone.add(ch.channelIndex);
      left.set(from.id, gone);
      const { zoneId: _zone, zoneRelativePosition: _rel, ...rest } = ch;
      return { ...rest, x: world.x, y: world.y, z: world.z };
    }
    return { ...ch, zoneRelativePosition: { x: unit(rel.x), y: unit(rel.y), z: unit(rel.z) } };
  });
  const out = zones.map((z) => {
    const next = cubed.get(z) ?? z;
    const gone = left.get(z.id);
    return gone ? { ...next, channelIndices: next.channelIndices.filter((i) => !gone.has(i)) } : next;
  });
  return { ...room, zones: out, hueChannels };
}

function finiteZone(z: HueZone): boolean {
  return AXES.every((a) => Number.isFinite(z[`center${a}`]) && Number.isFinite(z[`scale${a}`]));
}

function worldOf(ch: HueChannelPlacement, zone: HueZone): { x: number; y: number; z: number } {
  const rel = ch.zoneRelativePosition!;
  return {
    x: unit(zone.centerX + zone.scaleX * rel.x),
    y: unit(zone.centerY + zone.scaleY * rel.y),
    z: unit(zone.centerZ + zone.scaleZ * rel.z),
  };
}

// The middle of its three sides in metres as measured, which for a cube is its edge; grown to the
// lights' spread in the room it now stands in. The centre moves only as far as covering them needs,
// and stays put when they cannot all fit.
function toCube(zone: HueZone, lights: readonly { x: number; y: number; z: number }[], d: Dims, measuredIn: Dims): HueZone {
  const spread = (k: "x" | "y" | "z") => {
    const vs = lights.map((p) => p[k]);
    return vs.length ? { lo: Math.min(...vs), hi: Math.max(...vs) } : null;
  };
  const span = { x: spread("x"), y: spread("y"), z: spread("z") };
  const sides = AXES.map((a) => Math.abs(zone[`scale${a}`]) * sideOf(a, measuredIn)).sort((p, q) => p - q);
  let e = sides[1]!;
  for (const [k, a] of [["x", "X"], ["y", "Y"], ["z", "Z"]] as const) {
    const r = span[k];
    if (r) e = Math.max(e, ((r.hi - r.lo) / 2) * sideOf(a, d));
  }
  const s = scalesFor(e, d);
  const place = (k: "x" | "y" | "z", a: Axis, from: number) => {
    const r = span[k];
    const lo = Math.max(s[a] - 1, r ? r.hi - s[a] : -Infinity);
    const hi = Math.min(1 - s[a], r ? r.lo + s[a] : Infinity);
    return clamp(from, ...(lo <= hi ? [lo, hi] : [s[a] - 1, 1 - s[a]]) as [number, number]);
  };
  return {
    ...zone,
    scaleX: s.X,
    scaleY: s.Y,
    scaleZ: s.Z,
    centerX: place("x", "X", zone.centerX),
    centerY: place("y", "Y", zone.centerY),
    centerZ: place("z", "Z", zone.centerZ),
  };
}
