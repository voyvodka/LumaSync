import { useEffect, useState } from "react";

import { HUE_STATUS } from "@/shared/contracts/hue";

import { validateHueCredentials } from "../hueOnboardingApi";
import type { HueStartConfig } from "../model/hueStartConfig";

/** Interval for checking bridge reachability when configured but stream is not active. */
const HUE_BRIDGE_REACHABILITY_POLL_MS = 30_000;

// ---------------------------------------------------------------------------
// Bridge reachability poll: validate credentials every 30 s when hue is
// configured but stream is NOT active. Updates hueReachable so the chip
// accurately reflects whether the bridge is currently on the same network.
// While hue is streaming we skip polling — the active stream is proof enough.
//
// Visibility-aware (recursive setTimeout, not setInterval): the tray
// window can be hidden indefinitely with the React tree mounted, so
// unconditional 30 s ticks would keep firing HTTPS Bridge requests
// nobody can see. The loop pauses while hidden and resumes with an
// immediate first tick on `visibilitychange` so the chip refreshes
// instantly when the user re-opens the window.
// ---------------------------------------------------------------------------
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
