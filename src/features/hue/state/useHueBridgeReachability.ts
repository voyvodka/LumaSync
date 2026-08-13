import { useEffect, useState } from "react";

import { HUE_STATUS } from "@/shared/contracts/hue";

import { validateHueCredentials } from "../hueOnboardingApi";
import type { HueStartConfig } from "../model/hueStartConfig";

/** Interval for checking bridge reachability when configured but stream is not active. */
const HUE_BRIDGE_REACHABILITY_POLL_MS = 30_000;

// Validates credentials every 30 s while Hue is configured but not streaming —
// an active stream is proof enough on its own. Visibility-aware, per the
// convention in docs/architecture/ui-and-shell.md.
export function useHueBridgeReachability(
  hueStartConfig: HueStartConfig | null,
  hueStreaming: boolean,
): boolean {
  const [hueReachable, setHueReachable] = useState(false);

  useEffect(() => {
    if (!hueStartConfig || hueStreaming) return;

    let mounted = true;
    let timeoutId: number | null = null;
    let inFlight = false;

    const tick = async () => {
      if (!mounted) return;
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
        setHueReachable(validation.status.code === HUE_STATUS.CREDENTIAL_VALID);
      } catch {
        if (mounted) setHueReachable(false);
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
      }, HUE_BRIDGE_REACHABILITY_POLL_MS);
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
  }, [hueStartConfig, hueStreaming]);

  return hueReachable;
}
