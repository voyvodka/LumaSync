import { useCallback, useEffect, useRef, useState } from "react";

import { getHueStreamStatus } from "@/features/mode/modeApi";
import {
  HUE_AREA_CHANNELS_STATUS,
  HUE_RUNTIME_STATES,
  HUE_RUNTIME_STATUS,
} from "@/shared/contracts/hue";

import {
  getHueAreaChannels,
  type HueOnboardingCommandStatus,
  type HueAreaChannelInfo,
  type HueBridgeSummary,
  type HuePairingCredentials,
} from "../hueOnboardingApi";
import { toErrorDetails } from "../model/onboardingStatusCodes";
import type { HueAreaChannelsRead } from "../model/onboardingTypes";

export type { HueAreaChannelsRead };

export interface UseHueAreaChannelsResult {
  areaChannels: HueAreaChannelInfo[];
  isLoadingChannels: boolean;
  /** The last fetch's code, `null` before the first answer. Kept because an
   * empty area, an unreachable bridge and a parse failure all leave an empty
   * list, and the surface has to tell them apart. */
  channelsStatus: string | null;
  /** Whether `areaChannels` is the bridge's own arrangement; see
   *  `HueAreaChannelsRead.fromBridge`. */
  channelsFromBridge: boolean;
  /** Re-read the bridge's list; resolves with that read, `null` when there is
   *  nothing to read. A list fetched while a stream was running carries our
   *  own placements, not the bridge's. */
  refreshChannels: () => Promise<HueAreaChannelsRead | null>;
}

async function runtimeIsIdle(): Promise<boolean> {
  try {
    const result = await getHueStreamStatus();
    return result?.status?.state === HUE_RUNTIME_STATES.IDLE;
  } catch (error) {
    // `getHueStreamStatus` rejects with a plain `{ code, message }`, not an Error.
    const reason =
      error !== null && typeof error === "object" && "message" in error
        ? String((error as { message: unknown }).message)
        : toErrorDetails(error);
    console.warn(
      `[LumaSync] Hue runtime state unreadable, not trusting the channel list as the bridge's: ${reason}`,
    );
    return false;
  }
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
  const [channelsFromBridge, setChannelsFromBridge] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);

  // A read superseded by a newer one hands its waiters on rather than
  // answering them with a list the caller did not ask for.
  const waitersRef = useRef<Array<(read: HueAreaChannelsRead | null) => void>>([]);
  const settle = useCallback((read: HueAreaChannelsRead | null) => {
    const waiters = waitersRef.current;
    waitersRef.current = [];
    for (const resolve of waiters) resolve(read);
  }, []);

  const refreshChannels = useCallback(
    () =>
      new Promise<HueAreaChannelsRead | null>((resolve) => {
        waitersRef.current.push(resolve);
        setRefreshToken((n) => n + 1);
      }),
    [],
  );

  useEffect(() => () => settle(null), [settle]);

  // Held in a ref so an inline callback at the call site cannot widen the fetch
  // effect's dep array into a refetch-per-render loop.
  const onAuthInvalidRef = useRef(onAuthInvalid);
  onAuthInvalidRef.current = onAuthInvalid;

  // Load channels whenever the selected area or credentials change.
  useEffect(() => {
    if (!selectedBridge || !credentials || !selectedAreaId) {
      setAreaChannels([]);
      setChannelsStatus(null);
      setChannelsFromBridge(false);
      settle(null);
      return;
    }

    let cancelled = false;
    const areaId = selectedAreaId;
    const { ip } = selectedBridge;
    const { username } = credentials;

    setIsLoadingChannels(true);
    void (async () => {
      try {
        const idleBefore = await runtimeIsIdle();
        const { status, channels } = await getHueAreaChannels(ip, username, areaId);
        const idleAfter = await runtimeIsIdle();
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
          settle({ status: status.code, channels: [], fromBridge: false });
          return;
        }
        const answered =
          status.code === HUE_AREA_CHANNELS_STATUS.OK ||
          status.code === HUE_AREA_CHANNELS_STATUS.EMPTY;
        const fromBridge = answered && idleBefore && idleAfter;
        setAreaChannels(channels);
        setChannelsFromBridge(fromBridge);
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
        settle({ status: status.code, channels, fromBridge });
      } catch (error: unknown) {
        // The command itself never throws; this is the invoke layer rejecting —
        // an unregistered command or an IPC channel torn down mid-flight.
        if (cancelled) {
          return;
        }
        setAreaChannels([]);
        setChannelsStatus(HUE_AREA_CHANNELS_STATUS.FAILED);
        setChannelsFromBridge(false);
        console.warn(`[LumaSync] Hue area channel invoke rejected: ${toErrorDetails(error)}`);
        settle({ status: HUE_AREA_CHANNELS_STATUS.FAILED, channels: [], fromBridge: false });
      } finally {
        if (!cancelled) {
          setIsLoadingChannels(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [selectedBridge, credentials, selectedAreaId, refreshToken, settle]);

  return { areaChannels, isLoadingChannels, channelsStatus, channelsFromBridge, refreshChannels };
}
