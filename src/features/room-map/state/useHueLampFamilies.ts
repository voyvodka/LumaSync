import { useEffect, useMemo, useState } from "react";

import { getHueLightNames, type HueAreaChannelInfo } from "@/features/hue/hueOnboardingApi";
import { shellStore } from "@/features/persistence/shellStore";
import { channelLampFamily, type LampFamily } from "@/features/room-view/model/lampFamily";
import { HUE_LIGHT_NAMES_STATUS } from "@/shared/contracts/hue";
import { parseCommandError } from "@/shared/contracts/status";

/** Archetypes read this session, per bridge and set of lights: one bulk read, never polled. */
const archetypeCache = new Map<string, Readonly<Record<string, string | null>>>();

/** Test seam — the cache is module state. */
export function __resetHueLampFamilyCache(): void {
  archetypeCache.clear();
}

const NONE: ReadonlyMap<number, LampFamily> = new Map();

/** Each Hue channel's lamp shape (channel index → family), read from the bridge only while
 *  `enabled` — the 3D room is the one reader, so a closed view asks the bridge nothing. Until the
 *  answer lands, or without one, the map is empty and every light draws as a bulb. */
export function useHueLampFamilies(
  channels: readonly HueAreaChannelInfo[],
  enabled: boolean,
): ReadonlyMap<number, LampFamily> {
  const lightIds = useMemo(() => [...new Set(channels.flatMap((channel) => channel.lightIds))].sort(), [channels]);
  const [archetypes, setArchetypes] = useState<{ key: string; value: Readonly<Record<string, string | null>> } | null>(null);
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
        const key = `${ip}|${idsKey}`;
        const cached = archetypeCache.get(key);
        if (cached) {
          if (!cancelled) setArchetypes({ key: idsKey, value: cached });
          return;
        }
        // An empty app key is the keychain signal; the command resolves it there.
        const response = await getHueLightNames(ip, state.hueAppKey ?? "", lightIds);
        if (cancelled || response.status.code !== HUE_LIGHT_NAMES_STATUS.OK) return;
        const value = Object.fromEntries(response.lights.map((light) => [light.id, light.archetype]));
        archetypeCache.set(key, value);
        setArchetypes({ key: idsKey, value });
      })
      .catch((error: unknown) => {
        if (!cancelled) console.warn(`[LumaSync] Hue lamp shapes not read: ${parseCommandError(error).message}`);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, idsKey]);

  return useMemo(() => {
    if (archetypes === null || archetypes.key !== idsKey) return NONE;
    return new Map(channels.map((channel) => [channel.index, channelLampFamily(channel.lightIds, archetypes.value)]));
  }, [archetypes, channels, idsKey]);
}
