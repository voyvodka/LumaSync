import { useEffect, useMemo, useState } from "react";

import { HUE_STATUS } from "@/shared/contracts/hue";

import { validateHueCredentials } from "../hueOnboardingApi";
import type { HueStartConfig } from "../model/hueStartConfig";
import { createPollBudget } from "../model/pollBudget";
import { HUE_BRIDGE_REACHABILITY_POLL_MS } from "../model/pollingCadence";
import { requestHuePollRestart, useHuePollRestartToken } from "./huePollRestart";

export interface HueBridgeReachability {
  /** What the last completed probe found. Stays `false` once `gaveUp` is set. */
  reachable: boolean;
  /** The probe stopped after a sustained outage; only `retry` re-arms it. */
  gaveUp: boolean;
  retry: () => void;
}

// Validates credentials every 30 s while Hue is configured but not streaming —
// an active stream is proof enough on its own. Visibility-aware, per the
// convention in docs/architecture/ui-and-shell.md.
export function useHueBridgeReachability(
  hueStartConfig: HueStartConfig | null,
  hueStreaming: boolean,
): HueBridgeReachability {
  const [hueReachable, setHueReachable] = useState(false);
  const [gaveUp, setGaveUp] = useState(false);
  const restartToken = useHuePollRestartToken();

  useEffect(() => {
    if (!hueStartConfig || hueStreaming) {
      // An unpaired or streaming bridge has nothing to retry, so the banner
      // must not keep offering it one.
      setGaveUp(false);
      return;
    }

    let mounted = true;
    let timeoutId: number | null = null;
    let inFlight = false;
    let stopped = false;
    const budget = createPollBudget();
    setGaveUp(false);

    const noteFailure = (reason: string) => {
      const verdict = budget.recordFailure();
      // First of a streak only: at 30 s a sustained outage would otherwise
      // write a line every tick for as long as the app is open.
      if (verdict.streak === 1) {
        console.warn(`[LumaSync] Hue bridge probe failed: ${reason}`);
      }
      if (!verdict.exhausted) return;
      stopped = true;
      console.warn(
        `[LumaSync] Hue bridge probe gave up after ${verdict.streak} consecutive failures — manual retry required`,
      );
      if (mounted) setGaveUp(true);
    };

    const tick = async () => {
      if (!mounted || stopped) return;
      if (inFlight) return;
      if (document.visibilityState === "hidden") return;
      inFlight = true;
      try {
        const validation = await validateHueCredentials(
          hueStartConfig.bridgeIp,
          hueStartConfig.username,
          hueStartConfig.clientKey,
        );
        if (!mounted) return;
        const code = validation.status.code;
        setHueReachable(code === HUE_STATUS.CREDENTIAL_VALID);
        // Only a bridge that never answered counts against the budget. A
        // bridge that answers CREDENTIAL_INVALID is on the network and needs
        // a re-pair, which the Devices card already offers.
        if (code === HUE_STATUS.CREDENTIAL_CHECK_FAILED) noteFailure(code);
        else budget.recordSuccess();
      } catch (error) {
        if (!mounted) return;
        setHueReachable(false);
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
      }, HUE_BRIDGE_REACHABILITY_POLL_MS);
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
  }, [hueStartConfig, hueStreaming, restartToken]);

  return useMemo(
    () => ({ reachable: hueReachable, gaveUp, retry: requestHuePollRestart }),
    [gaveUp, hueReachable],
  );
}
