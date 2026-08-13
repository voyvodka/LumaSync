import { useEffect } from "react";

import { HUE_STATUS } from "@/shared/contracts/hue";

import { readHueStreamReadiness } from "../hueReadCache";
import type { checkHueStreamReadiness, HueBridgeSummary, HuePairingCredentials } from "../hueOnboardingApi";
import { createPollBudget } from "../model/pollBudget";
import { READINESS_BACKGROUND_REFRESH_MS, READINESS_BLOCKED_REFRESH_MS } from "../model/pollingCadence";
import { useHuePollRestartToken } from "./huePollRestart";

export interface UseHueReadinessPollingInput {
  bridge: HueBridgeSummary | null;
  credentials: HuePairingCredentials | null;
  areaId: string | null;
  /** Taken as a prop rather than read from the area rows, so the
   * active-streamer → 3 s cadence chain stays visible at the call site. */
  blocked: boolean;
  /** Kept as two flags rather than one OR'd `paused`, so the effect's dep array
   * still reacts to each of them the way it did before the split. */
  isValidatingCredential: boolean;
  isLoadingAreas: boolean;
  onResult: (areaId: string, response: Awaited<ReturnType<typeof checkHueStreamReadiness>>) => void;
}

// Two cadences in one effect: 15 s when the area is healthy, 3 s while a foreign
// active streamer blocks it — the fast one is what clears the banner without the
// user pressing revalidate. Visibility-aware; see docs/architecture/ui-and-shell.md.
export function useHueReadinessPolling({
  bridge,
  credentials,
  areaId: selectedAreaId,
  blocked,
  isValidatingCredential,
  isLoadingAreas,
  onResult,
}: UseHueReadinessPollingInput): void {
  const restartToken = useHuePollRestartToken();

  useEffect(() => {
    if (!bridge || !credentials || !selectedAreaId || isValidatingCredential || isLoadingAreas) {
      return;
    }

    let mounted = true;
    let timeoutId: number | null = null;
    let inFlight = false;
    let stopped = false;
    const bridgeIp = bridge.ip;
    const username = credentials.username;
    const areaId = selectedAreaId;
    const cadence = blocked ? READINESS_BLOCKED_REFRESH_MS : READINESS_BACKGROUND_REFRESH_MS;
    const budget = createPollBudget();

    const noteFailure = (reason: string) => {
      const verdict = budget.recordFailure();
      // First of a streak only — the blocked cadence is 3 s, so logging every
      // failed tick would bury the log sink during a single outage.
      if (verdict.streak === 1) {
        console.warn(`[LumaSync] Hue readiness refresh failed: ${reason}`);
      }
      if (!verdict.exhausted) return;
      stopped = true;
      console.warn(
        `[LumaSync] Hue readiness refresh gave up after ${verdict.streak} consecutive failures — manual retry required`,
      );
    };

    const tick = async () => {
      if (!mounted || stopped) return;
      if (inFlight) return;
      if (document.visibilityState === "hidden") return;
      inFlight = true;
      try {
        const response = await readHueStreamReadiness(bridgeIp, username, areaId);
        if (!mounted) return;
        onResult(areaId, response);
        // STREAM_NOT_READY is an answer, not a miss — an area held by another
        // streamer must never be counted as an unreachable bridge.
        if (response.status.code === HUE_STATUS.STREAM_READINESS_FAILED) {
          noteFailure(response.status.code);
        } else {
          budget.recordSuccess();
        }
      } catch (error) {
        if (!mounted) return;
        noteFailure(String(error));
      } finally {
        inFlight = false;
        if (!stopped) scheduleNext();
      }
    };

    const scheduleNext = () => {
      if (!mounted || stopped) return;
      if (document.visibilityState === "hidden") return;
      if (timeoutId !== null) return;
      timeoutId = window.setTimeout(() => {
        timeoutId = null;
        void tick();
      }, cadence);
    };

    const handleVisibilityChange = () => {
      if (!mounted || stopped) return;
      if (document.visibilityState === "visible" && timeoutId === null && !inFlight) {
        void tick();
      }
    };

    void tick();
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      mounted = false;
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
        timeoutId = null;
      }
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [
    blocked,
    bridge,
    credentials,
    isLoadingAreas,
    isValidatingCredential,
    onResult,
    restartToken,
    selectedAreaId,
  ]);
}
