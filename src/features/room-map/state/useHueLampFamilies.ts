import { useEffect, useMemo, useState } from "react";

import { getHueLightNames, type HueAreaChannelInfo } from "@/features/hue/hueOnboardingApi";
import {
  __resetHueLightCache,
  cachedHueLights,
  hueLightCacheKey,
  storeHueLights,
} from "@/features/hue/state/hueLightCache";
import { shellStore } from "@/features/persistence/shellStore";
import { channelLampFamily, type LampFamily } from "@/features/room-view/model/lampFamily";
import { HUE_LIGHT_NAMES_STATUS, type HueLightName } from "@/shared/contracts/hue";
import { parseCommandError } from "@/shared/contracts/status";

/** Test seam — the cache is module state, shared with the light names. */
export function __resetHueLampFamilyCache(): void {
  __resetHueLightCache();
}

const NONE: ReadonlyMap<number, LampFamily> = new Map();

const archetypesOf = (lights: readonly HueLightName[]): Readonly<Record<string, string | null>> =>
  Object.fromEntries(lights.map((light) => [light.id, light.archetype]));

/** Each Hue channel's lamp shape (channel index → family), read from the bridge only while
 *  `enabled` — while the room is open in a build with the 3D room: the view draws by it and the
 *  inspector names it, so a closed room asks the bridge nothing. It shares
 *  the light names' session cache, so the Hue page's read serves it and its Revalidate refreshes it.
 *  Until the answer lands, or without one, the map is empty and every light draws as a bulb. */
export function useHueLampFamilies(
  channels: readonly HueAreaChannelInfo[],
  enabled: boolean,
): ReadonlyMap<number, LampFamily> {
  const lightIds = useMemo(() => [...new Set(channels.flatMap((channel) => channel.lightIds))].sort(), [channels]);
  const [archetypes, setArchetypes] = useState<{ ids: string; value: Readonly<Record<string, string | null>> } | null>(null);
  const idsKey = lightIds.join(",");

  // biome-ignore lint/correctness/useExhaustiveDependencies: idsKey stands for lightIds
  useEffect(() => {
    if (!enabled || lightIds.length === 0) return;
    let cancelled = false;
    void shellStore
      .load()
      .then(async (state) => {
        const ip = state.lastHueBridge?.ip;
        if (!ip) return;
        const key = hueLightCacheKey(ip, lightIds);
        const cached = cachedHueLights(key);
        if (cached) {
          if (!cancelled) setArchetypes({ ids: idsKey, value: archetypesOf(cached) });
          return;
        }
        // An empty app key is the keychain signal; the command resolves it there.
        const response = await getHueLightNames(ip, state.hueAppKey ?? "", lightIds);
        if (response.status.code !== HUE_LIGHT_NAMES_STATUS.OK) {
          console.warn(
            `[LumaSync] Hue lamp shapes not read (${response.status.code}): ${response.status.details ?? response.status.message}`,
          );
          return;
        }
        // Kept even when the view closed meanwhile, so reopening it does not ask again.
        storeHueLights(key, response.lights);
        if (!cancelled) setArchetypes({ ids: idsKey, value: archetypesOf(response.lights) });
      })
      .catch((error: unknown) => {
        if (!cancelled) console.warn(`[LumaSync] Hue lamp shapes not read: ${parseCommandError(error).message}`);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, idsKey]);

  return useMemo(() => {
    if (archetypes === null || archetypes.ids !== idsKey) return NONE;
    return new Map(channels.map((channel) => [channel.index, channelLampFamily(channel.lightIds, archetypes.value)]));
  }, [archetypes, channels, idsKey]);
}
