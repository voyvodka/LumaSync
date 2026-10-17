import type { HueChannelPlacement, HueZone, RoomMapConfig } from "@/shared/contracts/roomMap";

import { ZONE_SCALE_MIN } from "./zoneRect";

// A Hue zone is a cube in the bridge's [-1, 1] space: one scale on all three axes. On the metre
// plan it is a box in the room's proportions, each axis mapping to its own side.

const SAME = 1e-9;
const AXES = ["X", "Y", "Z"] as const;

const unit = (v: number) => (Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0);
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export function isCubeZone(zone: HueZone): boolean {
  const s = zone.scaleX;
  return (
    s >= ZONE_SCALE_MIN - SAME &&
    s <= 1 + SAME &&
    Math.abs(zone.scaleY - s) <= SAME &&
    Math.abs(zone.scaleZ - s) <= SAME &&
    AXES.every((a) => Math.abs(zone[`center${a}`]) + s <= 1 + SAME)
  );
}

/** The cube of `size` (half its edge) at `centre`, its centre kept inside the Hue cube. */
export function withCubeScale(zone: HueZone, size: number, centre: { x: number; y: number; z: number } = { x: zone.centerX, y: zone.centerY, z: zone.centerZ }): HueZone {
  const s = clamp(size, ZONE_SCALE_MIN, 1);
  return {
    ...zone,
    scaleX: s,
    scaleY: s,
    scaleZ: s,
    centerX: clamp(centre.x, s - 1, 1 - s),
    centerY: clamp(centre.y, s - 1, 1 - s),
    centerZ: clamp(centre.z, s - 1, 1 - s),
  };
}

type Room = Pick<RoomMapConfig, "zones" | "hueChannels">;

/**
 * Every zone made a cube, each bound light kept where it resolved: the cube covers them, and their
 * relative positions are rewritten from it. Idempotent. A zone already a cube, or one with a
 * non-finite field (it cannot come off disk), is left as it is. Lights bind to the first zone with
 * their id, as both resolvers find it.
 */
export function cubeZones<T extends Room>(room: T): T {
  const zones = room.zones ?? [];
  if (zones.every((z) => !finiteZone(z) || isCubeZone(z))) return room;
  const channels = room.hueChannels ?? [];
  const firstWithId = new Map<string, HueZone>();
  for (const zone of zones) if (!firstWithId.has(zone.id)) firstWithId.set(zone.id, zone);
  const cubed = new Map<HueZone, HueZone>();
  for (const zone of firstWithId.values()) {
    if (!finiteZone(zone) || isCubeZone(zone)) continue;
    const bound = channels.filter((ch) => ch.zoneId === zone.id && ch.zoneRelativePosition);
    cubed.set(zone, toCube(zone, bound.map((ch) => worldOf(ch, zone))));
  }
  if (cubed.size === 0) return room;
  const hueChannels = channels.map((ch) => {
    const from = ch.zoneId ? firstWithId.get(ch.zoneId) : undefined;
    const to = from ? cubed.get(from) : undefined;
    if (!from || !to || !ch.zoneRelativePosition) return ch;
    const world = worldOf(ch, from);
    const s = to.scaleX;
    return { ...ch, zoneRelativePosition: { x: unit((world.x - to.centerX) / s), y: unit((world.y - to.centerY) / s), z: unit((world.z - to.centerZ) / s) } };
  });
  return { ...room, zones: zones.map((z) => cubed.get(z) ?? z), hueChannels };
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

// The floor plan keeps its size: the larger side, grown to cover the lights. A zone spanned the
// room's height, so its height is only the lights'; with none it sits at the middle.
function toCube(zone: HueZone, lights: readonly { x: number; y: number; z: number }[]): HueZone {
  const spread = (k: "x" | "y" | "z") => {
    const vs = lights.map((p) => p[k]);
    return vs.length ? { lo: Math.min(...vs), hi: Math.max(...vs) } : null;
  };
  const span = { x: spread("x"), y: spread("y"), z: spread("z") };
  let s = Math.max(Math.abs(zone.scaleX), Math.abs(zone.scaleY));
  for (const k of ["x", "y", "z"] as const) if (span[k]) s = Math.max(s, (span[k]!.hi - span[k]!.lo) / 2);
  s = clamp(s, ZONE_SCALE_MIN, 1);
  const place = (k: "x" | "y" | "z", from: number) => {
    const r = span[k];
    const lo = Math.max(s - 1, r ? r.hi - s : -Infinity);
    const hi = Math.min(1 - s, r ? r.lo + s : Infinity);
    return clamp(from, lo, Math.max(lo, hi));
  };
  const zMid = span.z ? (span.z.lo + span.z.hi) / 2 : 0;
  return { ...zone, scaleX: s, scaleY: s, scaleZ: s, centerX: place("x", zone.centerX), centerY: place("y", zone.centerY), centerZ: place("z", zMid) };
}
