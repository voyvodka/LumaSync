import type { HueChannelPlacement, HueZone, RoomDimensions, RoomMapConfig } from "@/shared/contracts/roomMap";

// Frozen for the 11 → 12 step: `room-map/model/zoneCube.ts` as it stood when zones became cubes in
// metres. The live one may change; a released step must not. This one was rewritten once, from cubes
// in Hue units, while schema 12 had shipped in no build.

const ZONE_SCALE_MIN = 0.05;

function zoneEdgeBounds(widthM: number, depthM: number, heightM: number): { min: number; max: number } {
  const min = ZONE_SCALE_MIN * Math.max(widthM, depthM, heightM);
  return { min, max: Math.max(min, Math.min(widthM, depthM, heightM)) };
}

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

function zoneEdge(zone: Pick<HueZone, "scaleX">, d: Dims): number {
  return Math.abs(zone.scaleX) * d.widthMeters;
}

function scalesFor(edge: number, d: Dims): Record<Axis, number> {
  const { min, max } = zoneEdgeBounds(d.widthMeters, d.depthMeters, d.heightMeters);
  const e = clamp(Number.isFinite(edge) ? edge : min, min, max);
  return { X: clamp(e / d.widthMeters, ZONE_SCALE_MIN, 1), Y: clamp(e / d.depthMeters, ZONE_SCALE_MIN, 1), Z: clamp(e / d.heightMeters, ZONE_SCALE_MIN, 1) };
}

function withCubeEdge(zone: HueZone, edge: number, d: Dims, centre: { x: number; y: number; z: number } = { x: zone.centerX, y: zone.centerY, z: zone.centerZ }): HueZone {
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

function isCubeZone(zone: HueZone, d: Dims): boolean {
  if (!finiteZone(zone)) return false;
  const cube = withCubeEdge(zone, zoneEdge(zone, d), d);
  return AXES.every(
    (a) => Math.abs(zone[`scale${a}`] - cube[`scale${a}`]) * sideOf(a, d) <= SAME_M && Math.abs(zone[`center${a}`] - cube[`center${a}`]) * sideOf(a, d) <= SAME_M,
  );
}



type Room = Pick<RoomMapConfig, "zones" | "hueChannels" | "dimensions">;

/**
 * Every zone made a cube in metres, each bound light kept where it resolved: the cube grows to cover
 * them up to the ceiling, and a light it still cannot hold leaves the zone where it stood. Clipping it
 * instead would move the light on the bridge. Idempotent. A zone already a cube, one with a non-finite
 * field, or a room without real dimensions is left as it is. Lights bind to the first zone with their
 * id, as both resolvers find it.
 */
export function cubeZonesV12<T extends Room>(room: T): T {
  const d = room.dimensions;
  const zones = room.zones ?? [];
  if (!validDims(d) || zones.every((z) => !finiteZone(z) || isCubeZone(z, d))) return room;
  const channels = room.hueChannels ?? [];
  const firstWithId = new Map<string, HueZone>();
  for (const zone of zones) if (!firstWithId.has(zone.id)) firstWithId.set(zone.id, zone);
  const cubed = new Map<HueZone, HueZone>();
  for (const zone of firstWithId.values()) {
    if (!finiteZone(zone) || isCubeZone(zone, d)) continue;
    const bound = channels.filter((ch) => ch.zoneId === zone.id && ch.zoneRelativePosition);
    cubed.set(zone, toCube(zone, bound.map((ch) => worldOf(ch, zone)), d));
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

// The middle of its three sides in metres; grown to the lights' spread. The centre moves only as far as covering them needs,
// and stays put when they cannot all fit.
function toCube(zone: HueZone, lights: readonly { x: number; y: number; z: number }[], d: Dims): HueZone {
  const spread = (k: "x" | "y" | "z") => {
    const vs = lights.map((p) => p[k]);
    return vs.length ? { lo: Math.min(...vs), hi: Math.max(...vs) } : null;
  };
  const span = { x: spread("x"), y: spread("y"), z: spread("z") };
  const sides = AXES.map((a) => Math.abs(zone[`scale${a}`]) * sideOf(a, d)).sort((p, q) => p - q);
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
