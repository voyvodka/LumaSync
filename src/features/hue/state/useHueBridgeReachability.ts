import { useMemo } from "react";

import { HUE_BRIDGE_VERDICT, type HueBridgeVerdict } from "@/shared/contracts/hueHealth";

import type { HueStartConfig } from "../model/hueStartConfig";
import { retryHueHealthProbe } from "./hueHealthStore";
import { sameJson, selectHueBridgeHealth, useHueHealth } from "./useHueHealth";

/** Why the bridge is or is not usable, so copy can tell a rejected key from a
 * bridge that never answered. `null` until a probe has completed. */
export type HueProbeVerdict = HueBridgeVerdict;

export interface HueBridgeReachability {
  /** What the last completed probe found. Stays `false` once `gaveUp` is set. */
  reachable: boolean;
  verdict: HueProbeVerdict | null;
  /** The probe stopped after a sustained outage; only `retry` re-arms it. */
  gaveUp: boolean;
  /** A probe is in flight. Without this the retry control has nothing to
   * render, so pressing it looks like it did nothing. */
  probing: boolean;
  retry: () => void;
}

/**
 * The bridge probe's verdict, from the health monitor, which validates the key
 * every 30 s while Hue is configured, not streaming and a window is visible —
 * an active stream is proof enough on its own. Read-only: the probe, its
 * give-up budget and the retry all live in Rust (`commands/hue/health.rs`).
 */
export function useHueBridgeReachability(
  hueStartConfig: HueStartConfig | null,
  hueStreaming: boolean,
): HueBridgeReachability {
  const bridge = useHueHealth(selectHueBridgeHealth, sameJson);
  const configured = hueStartConfig !== null;
  const verdict = configured ? (bridge?.verdict ?? null) : null;
  // An unpaired or streaming bridge has nothing to retry, so the banner
  // must not keep offering it one.
  const quiet = !configured || hueStreaming;
  const gaveUp = !quiet && (bridge?.gaveUp ?? false);
  const probing = !quiet && (bridge?.probing ?? false);

  return useMemo(
    () => ({
      reachable: verdict === HUE_BRIDGE_VERDICT.REACHABLE,
      verdict,
      gaveUp,
      probing,
      retry: retryHueHealthProbe,
    }),
    [gaveUp, probing, verdict],
  );
}
