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
  paused: boolean;
  onResult: (areaId: string, response: Awaited<ReturnType<typeof checkHueStreamReadiness>>) => void;
}

// Background readiness refresh.
//
// Two cadences share one effect:
//   * 15 s while the selected area is healthy (default polish cadence)
//   * 3 s while the area is blocked by a foreign active streamer, so
//     the active-streamer banner clears within ~3 s of the foreign
//     session disconnecting (A3.1 — previously the banner stayed
//     stuck until the user clicked revalidate).
//
// Visibility-aware: the loop pauses while `document.visibilityState`
// is `hidden` (tray window collapsed / minimised) and re-arms with an
// immediate tick on `visibilitychange`, mirroring the runtime-status
// loop and `useRuntimeTelemetry`.
export function useHueReadinessPolling({
  bridge,
  credentials,
  areaId: selectedAreaId,
  blocked,
  paused,
  onResult,
}: UseHueReadinessPollingInput): void {
  useEffect(() => {
    if (!bridge || !credentials || !selectedAreaId || paused) {
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
  }, [blocked, bridge, credentials, onResult, paused, selectedAreaId]);
}
