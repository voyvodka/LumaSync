import { useEffect } from "react";

import { readHueStreamReadiness } from "../hueReadCache";
import type { checkHueStreamReadiness, HueBridgeSummary, HuePairingCredentials } from "../hueOnboardingApi";
import { READINESS_BACKGROUND_REFRESH_MS, READINESS_BLOCKED_REFRESH_MS } from "../model/pollingCadence";

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
  useEffect(() => {
    if (!bridge || !credentials || !selectedAreaId || isValidatingCredential || isLoadingAreas) {
      return;
    }

    let mounted = true;
    let timeoutId: number | null = null;
    let inFlight = false;
    const bridgeIp = bridge.ip;
    const username = credentials.username;
    const areaId = selectedAreaId;
    const cadence = blocked ? READINESS_BLOCKED_REFRESH_MS : READINESS_BACKGROUND_REFRESH_MS;

    const tick = async () => {
      if (!mounted) return;
      if (inFlight) return;
      if (document.visibilityState === "hidden") return;
      inFlight = true;
      try {
        const response = await readHueStreamReadiness(bridgeIp, username, areaId);
        if (!mounted) return;
        onResult(areaId, response);
      } catch {
        // Background readiness refresh is best-effort.
      } finally {
        inFlight = false;
        scheduleNext();
      }
    };

    const scheduleNext = () => {
      if (!mounted) return;
      if (document.visibilityState === "hidden") return;
      if (timeoutId !== null) return;
      timeoutId = window.setTimeout(() => {
        timeoutId = null;
        void tick();
      }, cadence);
    };

    const handleVisibilityChange = () => {
      if (!mounted) return;
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
  }, [blocked, bridge, credentials, isLoadingAreas, isValidatingCredential, onResult, selectedAreaId]);
}
