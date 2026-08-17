import { useCallback, useEffect, useRef, useState } from "react";

import {
  HUE_RUNTIME_TRIGGER_SOURCE,
  type HueRuntimeTarget,
} from "@/shared/contracts/hue";
import { shellStore } from "@/features/persistence/shellStore";
import { restartHue, startHue } from "../../mode/modeApi";
import { toChannelPlacements } from "../model/hueStartConfig";
import { readHueStreamStatus } from "../hueReadCache";
import type { HueBridgeSummary, HuePairingCredentials } from "../hueOnboardingApi";
import {
  HUE_ONBOARDING_TRANSPORT_CODES as CODE,
  toErrorDetails,
  type HueOnboardingStatus,
  type HueRuntimeStatusView,
} from "../model/onboardingStatusCodes";
import { RUNTIME_POLL_INTERVAL_MS, RUNTIME_POLL_MIN_INTERVAL_MS, STREAMING_RUNTIME_STATES } from "../model/pollingCadence";
import { deriveRuntimeTargets, type HueRuntimeTargetRow } from "../model/runtimeTargets";

export interface UseHueRuntimeStatusInput {
  bridge: HueBridgeSummary | null;
  credentials: HuePairingCredentials | null;
  areaId: string | null;
  onError: (status: HueOnboardingStatus) => void;
}

export interface UseHueRuntimeStatusResult {
  runtimeStatus: HueRuntimeStatusView | null;
  runtimeTargets: HueRuntimeTargetRow[];
  isRuntimeMutating: boolean;
  startRuntime: () => Promise<void>;
  retryRuntimeTarget: (target: HueRuntimeTarget) => Promise<void>;
}

export function useHueRuntimeStatus({
  bridge,
  credentials,
  areaId,
  onError,
}: UseHueRuntimeStatusInput): UseHueRuntimeStatusResult {
  const [runtimeStatus, setRuntimeStatus] = useState<HueRuntimeStatusView | null>(null);
  /** Survives the runtime-loop effect re-running on every state transition. */
  const lastRuntimePollAtRef = useRef(0);
  const [runtimeTargets, setRuntimeTargets] = useState<HueRuntimeTargetRow[]>([]);
  const [isRuntimeMutating, setIsRuntimeMutating] = useState(false);

  // `force` bypasses the shared read cache. Mandatory after a mutation: a
  // cached pre-mutation status would paint the Devices tab with the state the
  // user just changed away from.
  const pollRuntimeStatus = useCallback(async (options?: { force?: boolean }) => {
    try {
      const result = await readHueStreamStatus(options?.force ? 0 : undefined);
      const nextStatus = result.status as HueRuntimeStatusView;
      setRuntimeStatus(nextStatus);
      setRuntimeTargets(deriveRuntimeTargets(nextStatus));
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error);
      const fallbackStatus: HueRuntimeStatusView = {
        state: "Failed",
        code: CODE.STREAM_STATUS_UNAVAILABLE,
        message: "Could not fetch Hue runtime status.",
        details,
        triggerSource: HUE_RUNTIME_TRIGGER_SOURCE.SYSTEM,
      };
      setRuntimeStatus(fallbackStatus);
      setRuntimeTargets(deriveRuntimeTargets(fallbackStatus));
    }
  }, []);

  // Polls only while the runtime is Starting / Running / Reconnecting; the other
  // states get the mount tick and go silent. Visibility-aware, per the convention
  // in docs/architecture/ui-and-shell.md.
  const runtimeState = runtimeStatus?.state ?? null;
  useEffect(() => {
    let mounted = true;
    let timeoutId: number | null = null;
    let inFlight = false;

    const isStreaming = runtimeState !== null && STREAMING_RUNTIME_STATES.has(runtimeState);

    const tick = async () => {
      if (!mounted) return;
      if (inFlight) return;
      if (document.visibilityState === "hidden") return;
      inFlight = true;
      lastRuntimePollAtRef.current = Date.now();
      try {
        await pollRuntimeStatus();
      } finally {
        inFlight = false;
        scheduleNext();
      }
    };

    // `runtimeState` only ever moves because a poll returned it, so an entry tick
    // here re-fetches what we hold — three round-trips per Idle→Running burst.
    const tickIfStale = () => {
      if (!mounted) return;
      if (timeoutId !== null || inFlight) return;
      if (Date.now() - lastRuntimePollAtRef.current >= RUNTIME_POLL_MIN_INTERVAL_MS) {
        void tick();
      } else {
        scheduleNext();
      }
    };

    const scheduleNext = () => {
      if (!mounted) return;
      if (!isStreaming) return;
      if (document.visibilityState === "hidden") return;
      if (timeoutId !== null) return;
      timeoutId = window.setTimeout(() => {
        timeoutId = null;
        void tick();
      }, RUNTIME_POLL_INTERVAL_MS);
    };

    const handleVisibilityChange = () => {
      if (!mounted) return;
      if (document.visibilityState === "visible") tickIfStale();
    };

    tickIfStale();
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      mounted = false;
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
        timeoutId = null;
      }
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [pollRuntimeStatus, runtimeState]);

  const startRuntime = useCallback(async () => {
    if (isRuntimeMutating || !bridge || !credentials || !areaId) {
      return;
    }

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
        details: toErrorDetails(error),
      });
    } finally {
      await pollRuntimeStatus({ force: true });
      setIsRuntimeMutating(false);
    }
  }, [areaId, bridge, credentials, isRuntimeMutating, onError, pollRuntimeStatus]);

  const retryRuntimeTarget = useCallback(
    async (target: HueRuntimeTarget) => {
      if (isRuntimeMutating || target !== "hue") {
        return;
      }

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
          details: toErrorDetails(error),
        });
      } finally {
        await pollRuntimeStatus({ force: true });
        setIsRuntimeMutating(false);
      }
    },
    [areaId, bridge, credentials, isRuntimeMutating, onError, pollRuntimeStatus],
  );

  return { runtimeStatus, runtimeTargets, isRuntimeMutating, startRuntime, retryRuntimeTarget };
}
