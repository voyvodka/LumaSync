import { useCallback, useEffect, useRef, useState } from "react";

import {
  HUE_RUNTIME_TRIGGER_SOURCE,
  type HueRuntimeTarget,
} from "@/shared/contracts/hue";
import { shellStore } from "@/features/persistence/shellStore";
import { parseCommandError } from "@/shared/contracts/status";
import { restartHue, startHue } from "../../mode/modeApi";
import { toChannelPlacements } from "../model/hueStartConfig";
import { readHueStreamStatus, subscribeHueStreamStatusInvalidation } from "../hueReadCache";
import type { HueBridgeSummary, HuePairingCredentials } from "../hueOnboardingApi";
import {
  HUE_ONBOARDING_TRANSPORT_CODES as CODE,
  type HueOnboardingStatus,
  type HueRuntimeStatusReadFailure,
  type HueRuntimeStatusView,
} from "../model/onboardingStatusCodes";
import {
  RUNTIME_POLL_INTERVAL_MS,
  RUNTIME_POLL_MIN_INTERVAL_MS,
  STREAMING_RUNTIME_STATES,
  runtimeStatusRetryDelayMs,
} from "../model/pollingCadence";
import { deriveRuntimeTargets, type HueRuntimeTargetRow } from "../model/runtimeTargets";

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

export function useHueRuntimeStatus({
  bridge,
  credentials,
  areaId,
  onError,
}: UseHueRuntimeStatusInput): UseHueRuntimeStatusResult {
  const [runtimeStatus, setRuntimeStatus] = useState<HueRuntimeStatusView | null>(null);
  const [runtimeStatusReadFailure, setRuntimeStatusReadFailure] =
    useState<HueRuntimeStatusReadFailure | null>(null);
  /** Consecutive rejected reads; drives the retry backoff. */
  const readFailuresRef = useRef(0);
  /** Survives the runtime-loop effect re-running on every state transition. */
  const lastRuntimePollAtRef = useRef(0);
  const [runtimeTargets, setRuntimeTargets] = useState<HueRuntimeTargetRow[]>([]);
  const [isRuntimeMutating, setIsRuntimeMutating] = useState(false);
  /** Our own start/restart does a forced read when it finishes; the
   * invalidation it fires on the way must not add a second one. */
  const isRuntimeMutatingRef = useRef(false);
  /** Survives the effect re-running, so a start that lands while a read is in
   * flight is not lost when that read's result changes `runtimeState`. */
  const refreshPendingRef = useRef(false);

  // `force` bypasses the shared read cache. Mandatory after a mutation: a
  // cached pre-mutation status would paint the Devices tab with the state the
  // user just changed away from.
  const pollRuntimeStatus = useCallback(async (options?: { force?: boolean }) => {
    // A forced read counts toward the floor too, so the loop's reaction to its
    // result does not fire a second read straight behind it.
    lastRuntimePollAtRef.current = Date.now();
    try {
      const result = await readHueStreamStatus(options?.force ? 0 : undefined);
      const nextStatus = result.status as HueRuntimeStatusView;
      readFailuresRef.current = 0;
      setRuntimeStatusReadFailure(null);
      setRuntimeStatus(nextStatus);
      setRuntimeTargets(deriveRuntimeTargets(nextStatus));
    } catch (error) {
      readFailuresRef.current += 1;
      setRuntimeStatusReadFailure({
        code: CODE.STREAM_STATUS_UNAVAILABLE,
        message: "Could not fetch Hue runtime status.",
        details: parseCommandError(error).message,
      });
    }
  }, []);

  // Polls only while the runtime is Starting / Running / Reconnecting; the other
  // states get the mount tick and go silent until a Hue start/stop/restart from
  // any surface invalidates the status. Without that wake-up a stream started
  // by the tray, a keybind or the boot restore while this tab was open left the
  // card on "Ready" beside a STREAMING status bar. Visibility-aware, per the convention in
  // docs/architecture/ui-and-shell.md.
  // A rejected read also keeps it polling, on a backoff, until a read lands.
  const runtimeState = runtimeStatus?.state ?? null;
  const isStatusReadFailing = runtimeStatusReadFailure !== null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: isStatusReadFailing re-arms the loop so a failing read keeps polling on backoff
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
      refreshPendingRef.current = false;
      try {
        await pollRuntimeStatus();
      } finally {
        inFlight = false;
        if (mounted && refreshPendingRef.current) {
          void tick();
        } else {
          scheduleNext();
        }
      }
    };

    // Bypasses the min-interval floor: the floor collapses re-reads of a state
    // we already hold, and an invalidation means that state just changed.
    const refreshAfterInvalidation = () => {
      if (!mounted) return;
      if (isRuntimeMutatingRef.current) return;
      if (inFlight) {
        refreshPendingRef.current = true;
        return;
      }
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
        timeoutId = null;
      }
      void tick();
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
      const failures = readFailuresRef.current;
      if (!isStreaming && failures === 0) return;
      if (document.visibilityState === "hidden") return;
      if (timeoutId !== null) return;
      timeoutId = window.setTimeout(
        () => {
          timeoutId = null;
          void tick();
        },
        failures > 0 ? runtimeStatusRetryDelayMs(failures) : RUNTIME_POLL_INTERVAL_MS,
      );
    };

    const handleVisibilityChange = () => {
      if (!mounted) return;
      if (document.visibilityState === "visible") tickIfStale();
    };

    if (refreshPendingRef.current) {
      void tick();
    } else {
      tickIfStale();
    }
    document.addEventListener("visibilitychange", handleVisibilityChange);
    const unsubscribeInvalidation = subscribeHueStreamStatusInvalidation(refreshAfterInvalidation);

    return () => {
      mounted = false;
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
        timeoutId = null;
      }
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      unsubscribeInvalidation();
    };
  }, [pollRuntimeStatus, runtimeState, isStatusReadFailing]);

  const startRuntime = useCallback(async () => {
    if (isRuntimeMutating || !bridge || !credentials || !areaId) {
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
      await pollRuntimeStatus({ force: true });
      isRuntimeMutatingRef.current = false;
      setIsRuntimeMutating(false);
    }
  }, [areaId, bridge, credentials, isRuntimeMutating, onError, pollRuntimeStatus]);

  const retryRuntimeTarget = useCallback(
    async (target: HueRuntimeTarget) => {
      if (isRuntimeMutating || target !== "hue") {
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
        await pollRuntimeStatus({ force: true });
        isRuntimeMutatingRef.current = false;
        setIsRuntimeMutating(false);
      }
    },
    [areaId, bridge, credentials, isRuntimeMutating, onError, pollRuntimeStatus],
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
