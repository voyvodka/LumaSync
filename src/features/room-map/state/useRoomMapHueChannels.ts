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
  /** The area's channels as the bridge reports them — light counts and all.
   *  Empty until a clean read lands. */
  areaChannels: HueAreaChannelInfo[];
  /** Last fetch's code, `null` before the first answer. */
  channelsStatus: string | null;
  isLoadingChannels: boolean;
  /** Bridge ids the area reports, or `null` when no clean read has landed. A
   *  placement outside a non-null set is a ghost; `null` marks nothing. An
   *  EMPTY set is a definite answer — the area really has no lights. */
  liveChannelIds: ReadonlySet<number> | null;
  refreshChannels: () => void;
}

/** Scoped to the area it came from: without that, switching areas would seed the
 *  previous area's channels under the new area's id. */
interface ChannelSnapshot {
  areaId: string;
  channels: HueAreaChannelInfo[];
  ids: Set<number>;
}

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
  const [snapshot, setSnapshot] = useState<ChannelSnapshot | null>(null);
  const [channelsStatus, setChannelsStatus] = useState<string | null>(null);
  const [isLoadingChannels, setIsLoadingChannels] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);

  const refreshChannels = useCallback(() => {
    setRefreshToken((n) => n + 1);
  }, []);

  useEffect(() => {
    if (!hueBridgeConfigured || !hueAreaId) {
      setChannelsStatus(null);
      return;
    }
    const areaId = hueAreaId;

    let cancelled = false;
    setIsLoadingChannels(true);

    void shellStore
      .load()
      .then((state) => {
        const ip = state.lastHueBridge?.ip;
        if (!ip) return null;
        // An empty app key is the keychain signal, and the command resolves it
        // there — passing `""` is correct, not a missing credential.
        return getHueAreaChannels(ip, state.hueAppKey ?? "", areaId);
      })
      .then((response) => {
        if (cancelled || !response) return;
        const { status, channels } = response;
        setChannelsStatus(status.code);
        // INVARIANT: only a clean read says anything about which lights the area
        // has. Unreachable, unparseable and 403 all arrive as an empty array
        // meaning "no answer", and adopting one is what turns a Wi-Fi blip into
        // a map full of ghosts. EMPTY is the one legitimate empty answer.
        if (
          status.code === HUE_AREA_CHANNELS_STATUS.OK ||
          status.code === HUE_AREA_CHANNELS_STATUS.EMPTY
        ) {
          setSnapshot({ areaId, channels, ids: liveChannelIdSet(channels) });
        }
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

  // A snapshot taken for another area is not an answer about this one.
  const current = snapshot !== null && snapshot.areaId === hueAreaId ? snapshot : null;

  // Seeding runs off refs so a placement edit cannot retrigger it — the effect
  // writes placements, and depending on them would make it feed itself.
  const configRef = useRef(config);
  configRef.current = config;
  const adoptRef = useRef(adoptConfig);
  adoptRef.current = adoptConfig;

  useEffect(() => {
    if (!ready || !hueAreaId || current === null || current.channels.length === 0) return;
    const stored = configRef.current.hueChannels;
    const { resolved, needsWrite } = seedChannelPlacements(
      current.channels,
      hueChannelsForArea(stored, hueAreaId),
      configRef.current.zones,
    );
    if (!needsWrite) return;
    // Stamped and merged, never assigned: the editor sees one area's channels,
    // so writing the resolved list wholesale deletes every other area's.
    const scoped = resolved.map((p) => ({ ...p, entertainmentAreaId: hueAreaId }));
    void adoptRef.current({ hueChannels: mergeHueChannels(stored, scoped) });
  }, [current, hueAreaId, ready]);

  return {
    areaChannels: current?.channels ?? [],
    channelsStatus,
    isLoadingChannels,
    liveChannelIds: current?.ids ?? null,
    refreshChannels,
  };
}
