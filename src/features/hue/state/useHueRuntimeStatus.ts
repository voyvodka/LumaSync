import { useCallback, useMemo, useRef, useState } from "react";

import {
  HUE_RUNTIME_TRIGGER_SOURCE,
  type HueRuntimeTarget,
} from "@/shared/contracts/hue";
import { shellStore } from "@/features/persistence/shellStore";
import { parseCommandError } from "@/shared/contracts/status";
import { restartHue, startHue } from "../../mode/modeApi";
import { toChannelPlacements } from "../model/hueStartConfig";
import type { HueBridgeSummary, HuePairingCredentials } from "../hueOnboardingApi";
import {
  HUE_ONBOARDING_TRANSPORT_CODES as CODE,
  type HueOnboardingStatus,
  type HueRuntimeStatusReadFailure,
  type HueRuntimeStatusView,
} from "../model/onboardingStatusCodes";
import { deriveRuntimeTargets, type HueRuntimeTargetRow } from "../model/runtimeTargets";
import { refreshHueHealth } from "./hueHealthStore";
import {
  sameJson,
  selectHueReadFailure,
  selectHueRuntimeStatus,
  useHueHealth,
} from "./useHueHealth";

export interface UseHueRuntimeStatusInput {
  bridge: HueBridgeSummary | null;
  credentials: HuePairingCredentials | null;
  areaId: string | null;
  onError: (status: HueOnboardingStatus) => void;
}

export interface UseHueRuntimeStatusResult {
  /** The last status the backend reported; kept through a failed read. */
  runtimeStatus: HueRuntimeStatusView | null;
  /** Set while the latest read rejected, so `runtimeStatus` may be stale. */
  runtimeStatusReadFailure: HueRuntimeStatusReadFailure | null;
  runtimeTargets: HueRuntimeTargetRow[];
  isRuntimeMutating: boolean;
  startRuntime: () => Promise<void>;
  retryRuntimeTarget: (target: HueRuntimeTarget) => Promise<void>;
}

/**
 * The Devices view's runtime status, read from the health monitor's snapshot,
 * and the card's own start and restart. Rust publishes every state change of
 * the runtime, whichever surface caused it, so there is no loop to wake.
 */
export function useHueRuntimeStatus({
  bridge,
  credentials,
  areaId,
  onError,
}: UseHueRuntimeStatusInput): UseHueRuntimeStatusResult {
  const runtimeStatus = useHueHealth(selectHueRuntimeStatus, sameJson);
  const runtimeStatusReadFailure = useHueHealth(selectHueReadFailure);
  const runtimeTargets = useMemo(() => deriveRuntimeTargets(runtimeStatus), [runtimeStatus]);
  const [isRuntimeMutating, setIsRuntimeMutating] = useState(false);
  const isRuntimeMutatingRef = useRef(false);

  // A fresh read after our own mutation is mandatory: the card must not paint
  // the state the user just changed away from while the event is in flight.
  const startRuntime = useCallback(async () => {
    if (isRuntimeMutatingRef.current || !bridge || !credentials || !areaId) {
      return;
    }

    isRuntimeMutatingRef.current = true;
    setIsRuntimeMutating(true);
    try {
      await startHue({
        bridgeIp: bridge.ip,
        username: credentials.username,
        clientKey: credentials.clientKey,
        areaId,
        triggerSource: HUE_RUNTIME_TRIGGER_SOURCE.DEVICE_SURFACE,
        channelPlacements: toChannelPlacements((await shellStore.load()).roomMap, areaId),
      });
    } catch (error) {
      onError({
        code: CODE.STREAM_START_FAILED,
        message: "Could not start Hue stream.",
        details: parseCommandError(error).message,
      });
    } finally {
      await refreshHueHealth();
      isRuntimeMutatingRef.current = false;
      setIsRuntimeMutating(false);
    }
  }, [areaId, bridge, credentials, onError]);

  const retryRuntimeTarget = useCallback(
    async (target: HueRuntimeTarget) => {
      if (isRuntimeMutatingRef.current || target !== "hue") {
        return;
      }

      isRuntimeMutatingRef.current = true;
      setIsRuntimeMutating(true);
      try {
        if (bridge && credentials && areaId) {
          await restartHue({
            bridgeIp: bridge.ip,
            username: credentials.username,
            clientKey: credentials.clientKey,
            areaId,
            triggerSource: HUE_RUNTIME_TRIGGER_SOURCE.DEVICE_SURFACE,
            channelPlacements: toChannelPlacements((await shellStore.load()).roomMap, areaId),
          });
        }
      } catch (error) {
        onError({
          code: CODE.STREAM_RECOVERY_FAILED,
          message: "Could not recover Hue stream.",
          details: parseCommandError(error).message,
        });
      } finally {
        await refreshHueHealth();
        isRuntimeMutatingRef.current = false;
        setIsRuntimeMutating(false);
      }
    },
    [areaId, bridge, credentials, onError],
  );

  return {
    runtimeStatus,
    runtimeStatusReadFailure,
    runtimeTargets,
    isRuntimeMutating,
    startRuntime,
    retryRuntimeTarget,
  };
}
