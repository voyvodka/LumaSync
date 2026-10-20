import type { HueLightName } from "@/shared/contracts/hue";

/** Lights read this session, per bridge and set of light ids — one bulk read that the names and the
 *  3D room's lamp shapes both serve from. Nothing polls; Revalidate drops the entry for both. */
const cache = new Map<string, readonly HueLightName[]>();

export function hueLightCacheKey(ip: string, lightIds: readonly string[]): string {
  return `${ip}|${[...new Set(lightIds)].sort().join(",")}`;
}

export function cachedHueLights(key: string): readonly HueLightName[] | undefined {
  return cache.get(key);
}

export function storeHueLights(key: string, lights: readonly HueLightName[]): void {
  cache.set(key, lights);
}

export function forgetHueLights(key: string): void {
  cache.delete(key);
}

/** Test seam — the cache is module state. */
export function __resetHueLightCache(): void {
  cache.clear();
}
