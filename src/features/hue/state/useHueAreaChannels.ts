import { useCallback, useEffect, useState } from "react";

import { shellStore } from "../../persistence/shellStore";
import {
  getHueAreaChannels,
  type HueAreaChannelInfo,
  type HueBridgeSummary,
  type HuePairingCredentials,
} from "../hueOnboardingApi";

export interface UseHueAreaChannelsResult {
  areaChannels: HueAreaChannelInfo[];
  isLoadingChannels: boolean;
  channelRegionOverrides: Record<number, string>;
  setChannelRegion: (channelIndex: number, region: string | null) => void;
}

export function useHueAreaChannels(
  selectedBridge: HueBridgeSummary | null,
  credentials: HuePairingCredentials | null,
  selectedAreaId: string | null,
): UseHueAreaChannelsResult {
  const [areaChannels, setAreaChannels] = useState<HueAreaChannelInfo[]>([]);
  const [isLoadingChannels, setIsLoadingChannels] = useState(false);
  const [channelRegionOverrides, setChannelRegionOverrides] = useState<Record<number, string>>({});

  // Load channels whenever the selected area or credentials change.
  useEffect(() => {
    if (!selectedBridge || !credentials || !selectedAreaId) {
      setAreaChannels([]);
      return;
    }

    let cancelled = false;
    const areaId = selectedAreaId;
    const { ip } = selectedBridge;
    const { username } = credentials;

    setIsLoadingChannels(true);
    void getHueAreaChannels(ip, username, areaId)
      .then((channels) => {
        if (!cancelled) {
          setAreaChannels(channels);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setAreaChannels([]);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoadingChannels(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [selectedBridge, credentials, selectedAreaId]);

  // Load channel overrides for the selected area from the store.
  useEffect(() => {
    if (!selectedAreaId) {
      setChannelRegionOverrides({});
      return;
    }

    const areaId = selectedAreaId;
    void shellStore.load().then((stored) => {
      const overrides = stored.hueChannelRegionOverrides?.[areaId] ?? {};
      setChannelRegionOverrides(overrides);
    });
  }, [selectedAreaId]);

  const setChannelRegion = useCallback(
    (channelIndex: number, region: string | null) => {
      if (!selectedAreaId) return;

      const areaId = selectedAreaId;
      setChannelRegionOverrides((prev) => {
        const next = { ...prev };
        if (region === null) {
          delete next[channelIndex];
        } else {
          next[channelIndex] = region;
        }

        void shellStore.load().then((stored) => {
          const allOverrides = { ...(stored.hueChannelRegionOverrides ?? {}) };
          if (Object.keys(next).length === 0) {
            delete allOverrides[areaId];
          } else {
            allOverrides[areaId] = next;
          }
          void shellStore.save({ hueChannelRegionOverrides: allOverrides });
        });

        return next;
      });
    },
    [selectedAreaId],
  );

  return { areaChannels, isLoadingChannels, channelRegionOverrides, setChannelRegion };
}
