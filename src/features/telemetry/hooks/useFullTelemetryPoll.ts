import { useEffect, useState } from "react";

import { getFullTelemetrySnapshot } from "../telemetryApi";
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
 * Polled-snapshot hook that surfaces the full telemetry payload (USB + Hue)
 * every `pollIntervalMs` (default 1 Hz). Mirrors the recursive-setTimeout +
 * visibilitychange skeleton used by `useRuntimeTelemetry`, but returns the
 * raw `FullTelemetrySnapshot` so consumers can pick whichever facets matter
 * (LightsSection reads `.usb`; TelemetrySection consumes the whole shape +
 * the diagnostic-grade error/loading flags).
 *
 * Why no `setInterval`: the recursive timer pattern guarantees that a slow
 * `invoke()` round-trip never queues overlapping calls — the next tick is
 * only armed after the previous response resolves.
 *
 * Why visibility-aware: the LumaSync tray window can be hidden indefinitely
 * while sections stay React-mounted, so an unconditional setInterval would
 * fire `getFullTelemetrySnapshot` IPC calls into a UI nobody is looking at.
 * When the page goes hidden, the loop holds the last-known snapshot (do not
 * flicker on transient absence) and resumes with an immediate tick on
 * `visibilitychange`.
 *
 * Why `enabled` rather than two hooks: the LightsSection poll must pause
 * when the user is not in Ambilight mode; the TelemetrySection poll must
 * pause when USB is disconnected. Same shape, single switch.
 *
 * @param enabled — caller's domain gate (e.g. `isAmbilight`, `usbConnected`)
 * @param pollIntervalMs — defaults to 1 s
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

    setResult((prev) => ({ ...prev, isLoading: prev.snapshot === null }));

    let mounted = true;
    let timeoutId: number | null = null;
    let inFlight = false;

    const scheduleNext = () => {
      if (!mounted) return;
      if (document.visibilityState === "hidden") return;
      if (timeoutId !== null) return;
      timeoutId = window.setTimeout(() => {
        timeoutId = null;
        void tick();
      }, pollIntervalMs);
    };

    const tick = async () => {
      if (!mounted) return;
      if (inFlight) return;
      if (document.visibilityState === "hidden") return;
      inFlight = true;
      try {
        const next = await getFullTelemetrySnapshot();
        if (!mounted) return;
        setResult({ snapshot: next, error: null, isLoading: false });
      } catch (raw) {
        if (!mounted) return;
        const error = raw instanceof Error ? raw : new Error(String(raw));
        // Surface the error to the caller (TelemetrySection diagnostic
        // page renders an inline fallback) and log so silent-catch is not
        // smuggled in. Snapshot is preserved — a single failed tick must
        // not zero out the last-known good values.
        console.error("[LumaSync] useFullTelemetryPoll tick failed:", error);
        setResult((prev) => ({ snapshot: prev.snapshot, error, isLoading: false }));
      } finally {
        inFlight = false;
        scheduleNext();
      }
    };

    const handleVisibilityChange = () => {
      if (!mounted) return;
      if (document.visibilityState === "visible") {
        if (timeoutId === null && !inFlight) {
          void tick();
        }
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
  }, [enabled, pollIntervalMs]);

  return result;
}
