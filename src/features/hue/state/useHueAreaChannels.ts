import { useEffect, useRef, useState } from "react";

import { HUE_AREA_CHANNELS_STATUS, HUE_RUNTIME_STATUS } from "@/shared/contracts/hue";

import {
  getHueAreaChannels,
  type HueOnboardingCommandStatus,
  type HueAreaChannelInfo,
  type HueBridgeSummary,
  type HuePairingCredentials,
} from "../hueOnboardingApi";
import { toErrorDetails } from "../model/onboardingStatusCodes";

export interface UseHueAreaChannelsResult {
  areaChannels: HueAreaChannelInfo[];
  isLoadingChannels: boolean;
  /** The last fetch's code, `null` before the first answer. Kept because an
   * empty area, an unreachable bridge and a parse failure all leave an empty
   * list, and the surface has to tell them apart. */
  channelsStatus: string | null;
}

export function useHueAreaChannels(
  selectedBridge: HueBridgeSummary | null,
  credentials: HuePairingCredentials | null,
  selectedAreaId: string | null,
  /** Invoked when the channel fetch is rejected specifically by a bridge 403. */
  onAuthInvalid?: (status: HueOnboardingCommandStatus) => void,
): UseHueAreaChannelsResult {
  const [areaChannels, setAreaChannels] = useState<HueAreaChannelInfo[]>([]);
  const [isLoadingChannels, setIsLoadingChannels] = useState(false);
  const [channelsStatus, setChannelsStatus] = useState<string | null>(null);

  // Held in a ref so an inline callback at the call site cannot widen the fetch
  // effect's dep array into a refetch-per-render loop.
  const onAuthInvalidRef = useRef(onAuthInvalid);
  onAuthInvalidRef.current = onAuthInvalid;

  // Load channels whenever the selected area or credentials change.
  useEffect(() => {
    if (!selectedBridge || !credentials || !selectedAreaId) {
      setAreaChannels([]);
      setChannelsStatus(null);
      return;
    }

    let cancelled = false;
    const areaId = selectedAreaId;
    const { ip } = selectedBridge;
    const { username } = credentials;

    setIsLoadingChannels(true);
    void getHueAreaChannels(ip, username, areaId)
      .then(({ status, channels }) => {
        if (cancelled) {
          return;
        }
        // INVARIANT: an unreachable bridge must leave the list alone. The empty
        // array on that code means "no answer", not "no channels", and clearing
        // here is what makes a Wi-Fi blip look like a deleted area.
        setChannelsStatus(status.code);
        if (status.code === HUE_AREA_CHANNELS_STATUS.UNREACHABLE) {
          console.warn(
            `[LumaSync] Hue bridge unreachable, keeping last known channels: ${status.details ?? status.message}`,
          );
          return;
        }
        setAreaChannels(channels);
        // Only the 403 escalates — a transient bridge failure must not prompt
        // a re-pair. An empty area is `HUE_AREA_CHANNELS_EMPTY`, not a failure.
        if (status.code === HUE_RUNTIME_STATUS.AUTH_INVALID_RE_PAIR_REQUIRED) {
          // Spread, not rebuild: keeps the bridge's own message and details.
          // The literal re-pins `code` into the narrower onboarding union.
          onAuthInvalidRef.current?.({
            ...status,
            code: HUE_RUNTIME_STATUS.AUTH_INVALID_RE_PAIR_REQUIRED,
          });
        } else if (status.code === HUE_AREA_CHANNELS_STATUS.FAILED) {
          console.warn(`[LumaSync] Hue area channel fetch failed: ${status.details ?? status.message}`);
        }
      })
      .catch((error: unknown) => {
        // The command itself never throws; this is the invoke layer rejecting —
        // an unregistered command or an IPC channel torn down mid-flight.
        if (cancelled) {
          return;
        }
        setAreaChannels([]);
        setChannelsStatus(HUE_AREA_CHANNELS_STATUS.FAILED);
        console.warn(`[LumaSync] Hue area channel invoke rejected: ${toErrorDetails(error)}`);
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

  return { areaChannels, isLoadingChannels, channelsStatus };
}
