import type { HueChannelPlacement, HueZone, ZoneRelativePosition } from "@/shared/contracts/roomMap";
import { clamp } from "@/shared/lib/math";

/** Where it lands in the zone, so it joins at the spot it was dropped on; the smallest zone wins. */
export function zoneDrop(channel: HueChannelPlacement, zones: readonly HueZone[]): { zoneId: string; at: ZoneRelativePosition } | null {
  if (channel.zoneId) return null;
  const area = channel.entertainmentAreaId;
  let zone: HueZone | null = null;
  for (const z of zones) {
    if (area && z.entertainmentAreaId !== area) continue;
    if (Math.abs(channel.x - z.centerX) > Math.abs(z.scaleX) || Math.abs(channel.y - z.centerY) > Math.abs(z.scaleY)) continue;
    if (!zone || Math.abs(z.scaleX * z.scaleY) < Math.abs(zone.scaleX * zone.scaleY)) zone = z;
  }
  if (!zone) return null;
  const rel = (value: number, centre: number, scale: number) => (scale === 0 ? 0 : clamp((value - centre) / scale, -1, 1));
  return {
    zoneId: zone.id,
    at: { x: rel(channel.x, zone.centerX, zone.scaleX), y: rel(channel.y, zone.centerY, zone.scaleY), z: rel(channel.z, zone.centerZ, zone.scaleZ) },
  };
}

/** Only drawn zones take a light: a hidden one took it unseen. */
export function dropZones(zones: readonly HueZone[], activeZoneId: string | null, showAll: boolean): readonly HueZone[] {
  return showAll ? zones : zones.filter((zone) => zone.id === activeZoneId);
}
