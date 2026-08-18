import { useCallback, useEffect, useRef, useState } from "react";

import { shellStore } from "@/features/persistence/shellStore";
import { getHueAreaChannels, type HueAreaChannelInfo } from "@/features/hue/hueOnboardingApi";
import { HUE_AREA_CHANNELS_STATUS } from "@/shared/contracts/hue";
import type { RoomMapConfig } from "@/shared/contracts/roomMap";
import { hueChannelsForArea, mergeHueChannels } from "@/shared/contracts/roomMap";

import { liveChannelIdSet, seedChannelPlacements } from "../model/hueChannelSeeding";

export interface UseRoomMapHueChannelsArgs {
  config: RoomMapConfig;
  /** History-free, because reconciling with the bridge is not a user edit. */
  adoptConfig: (partial: Partial<RoomMapConfig>) => Promise<void>;
  hueAreaId: string | null;
  hueBridgeConfigured: boolean;
  /** False while the persisted map is still loading — seeding into the default
   *  map would be overwritten by the load a moment later. */
  ready: boolean;
}

export interface UseRoomMapHueChannelsReturn {
  /** Last fetch's code, `null` before the first answer. */
  channelsStatus: string | null;
  isLoadingChannels: boolean;
  /** Bridge ids the area reports. A placement whose `channelId` is missing here
   *  is a ghost. Empty while the list is unknown — treat it as "cannot tell",
   *  never as "everything is a ghost". */
  liveChannelIds: ReadonlySet<number>;
  refreshChannels: () => void;
}

const NO_IDS: ReadonlySet<number> = new Set<number>();

/** Not `useHueOnboarding`: a second copy of that state machine doubles its poll
 *  loop, which is why the editor stayed bridge-blind. Fetches on open and on
 *  demand, never on a timer. */
export function useRoomMapHueChannels({
  config,
  adoptConfig,
  hueAreaId,
  hueBridgeConfigured,
  ready,
}: UseRoomMapHueChannelsArgs): UseRoomMapHueChannelsReturn {
  const [areaChannels, setAreaChannels] = useState<HueAreaChannelInfo[]>([]);
  const [channelsStatus, setChannelsStatus] = useState<string | null>(null);
  const [isLoadingChannels, setIsLoadingChannels] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);

  const refreshChannels = useCallback(() => {
    setRefreshToken((n) => n + 1);
  }, []);

  useEffect(() => {
    if (!hueBridgeConfigured || !hueAreaId) {
      setAreaChannels([]);
      setChannelsStatus(null);
      return;
    }

    let cancelled = false;
    setIsLoadingChannels(true);

    void shellStore
      .load()
      .then((state) => {
        const ip = state.lastHueBridge?.ip;
        if (!ip) return null;
        // An empty app key is the keychain signal, and the command resolves it
        // there — passing `""` is correct, not a missing credential.
        return getHueAreaChannels(ip, state.hueAppKey ?? "", hueAreaId);
      })
      .then((response) => {
        if (cancelled || !response) return;
        const { status, channels } = response;
        setChannelsStatus(status.code);
        // INVARIANT: an unreachable bridge must leave the list alone. The empty
        // array on that code means "no answer", not "no channels", and clearing
        // here is what turns a Wi-Fi blip into a map full of ghosts.
        if (status.code === HUE_AREA_CHANNELS_STATUS.UNREACHABLE) return;
        setAreaChannels(channels);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setChannelsStatus(HUE_AREA_CHANNELS_STATUS.FAILED);
        console.warn(`[LumaSync] Room map Hue channel fetch failed: ${String(error)}`);
      })
      .finally(() => {
        if (!cancelled) setIsLoadingChannels(false);
      });

    return () => {
      cancelled = true;
    };
  }, [hueBridgeConfigured, hueAreaId, refreshToken]);

  // Seeding runs off refs so a placement edit cannot retrigger it — the effect
  // writes placements, and depending on them would make it feed itself.
  const configRef = useRef(config);
  configRef.current = config;
  const adoptRef = useRef(adoptConfig);
  adoptRef.current = adoptConfig;

  useEffect(() => {
    if (!ready || !hueAreaId || areaChannels.length === 0) return;
    const stored = configRef.current.hueChannels;
    const { resolved, needsWrite } = seedChannelPlacements(
      areaChannels,
      hueChannelsForArea(stored, hueAreaId),
      configRef.current.zones,
    );
    if (!needsWrite) return;
    // Stamped and merged, never assigned: the editor sees one area's channels,
    // so writing the resolved list wholesale deletes every other area's.
    const scoped = resolved.map((p) => ({ ...p, entertainmentAreaId: hueAreaId }));
    void adoptRef.current({ hueChannels: mergeHueChannels(stored, scoped) });
  }, [areaChannels, hueAreaId, ready]);

  return {
    channelsStatus,
    isLoadingChannels,
    liveChannelIds: areaChannels.length > 0 ? liveChannelIdSet(areaChannels) : NO_IDS,
    refreshChannels,
  };
}
