import { useEffect, useState } from "react";

import { subscribeTelemetry } from "../telemetrySource";
import type { FullTelemetrySnapshot } from "../model/contracts";

const DEFAULT_POLL_INTERVAL_MS = 1000;

/**
 * Caller-facing result shape. `snapshot` is `null` until the first
 * successful tick; `error` reflects only the most recent tick's failure
 * (cleared by the next success). `isLoading` is `true` between mount and
 * the first resolved tick — caller can render a "loading…" affordance
 * without coordinating its own state.
 */
export interface FullTelemetryPollResult {
  snapshot: FullTelemetrySnapshot | null;
  error: Error | null;
  isLoading: boolean;
}

const INITIAL_RESULT: FullTelemetryPollResult = {
  snapshot: null,
  error: null,
  isLoading: true,
};

/**
 * Full telemetry payload (USB + Hue) from the shared loop in
 * `../telemetrySource`, which owns cadence, visibility gating and the
 * in-flight guard. `enabled` is the caller's domain gate (`isAmbilight`,
 * `usbConnected`); the shared loop stops once every consumer is disabled.
 */
export function useFullTelemetryPoll(
  enabled: boolean,
  pollIntervalMs: number = DEFAULT_POLL_INTERVAL_MS,
): FullTelemetryPollResult {
  const [result, setResult] = useState<FullTelemetryPollResult>(INITIAL_RESULT);

  useEffect(() => {
    if (!enabled) {
      // Reset so re-enabling does not flash a stale value while the first
      // tick is still pending. `isLoading=false` because the consumer is
      // explicitly idle, not waiting on a fetch.
      setResult({ snapshot: null, error: null, isLoading: false });
      return;
    }

    return subscribeTelemetry(pollIntervalMs, (next) => {
      setResult({
        snapshot: next.snapshot,
        error: next.error,
        isLoading: next.isLoading,
      });
    });
  }, [enabled, pollIntervalMs]);

  return result;
}
