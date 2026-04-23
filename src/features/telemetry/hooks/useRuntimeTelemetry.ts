import { useEffect, useState } from "react";

import { getFullTelemetrySnapshot } from "../telemetryApi";
import type { FullTelemetrySnapshot } from "../model/contracts";

/**
 * Snapshot shape surfaced to consumers (StatusBar FPS pill, future readouts).
 *
 * `fps` is `null` when Ambilight is not actively pushing frames — the
 * StatusBar renders an "FPS —" placeholder in that case instead of a misleading
 * zero. Once ambilight starts, the snapshot exposes the backend capture FPS.
 *
 * `latencyMs` mirrors `frameLatencyMs` from the backend telemetry contract;
 * `frameDrops` is derived from the capture/send delta so consumers can surface
 * queue pressure without reading the raw enum.
 */
export interface RuntimeTelemetrySnapshot {
  /** Backend capture FPS, or `null` when no frames are flowing. */
  fps: number | null;
  /** EWMA of capture+send cost in milliseconds, or `null` before first frame. */
  latencyMs: number | null;
  /** Non-negative integer, derived from capture/send delta; clamped to 0. */
  frameDrops: number;
  /** `performance.now()` at the moment the snapshot was received. */
  timestamp: number;
}

const DEFAULT_POLL_INTERVAL_MS = 1000;

const INITIAL_SNAPSHOT: RuntimeTelemetrySnapshot = {
  fps: null,
  latencyMs: null,
  frameDrops: 0,
  timestamp: 0,
};

/**
 * Normalize a raw telemetry payload into the StatusBar-facing snapshot. A
 * `captureFps` of exactly 0 is treated as "inactive" (null) so consumers can
 * render a neutral placeholder instead of a misleading `0 FPS` chip.
 */
function projectSnapshot(dto: FullTelemetrySnapshot): RuntimeTelemetrySnapshot {
  const captureFps = dto.usb.captureFps;
  const sendFps = dto.usb.sendFps;
  const active = captureFps > 0 || sendFps > 0;
  const frameDrops = Math.max(0, Math.round(captureFps - sendFps));

  return {
    fps: active ? captureFps : null,
    latencyMs: active ? dto.usb.frameLatencyMs : null,
    frameDrops: active ? frameDrops : 0,
    timestamp: performance.now(),
  };
}

/**
 * Polling hook that surfaces the runtime telemetry snapshot every
 * `pollIntervalMs` (default 1 Hz). Uses the recursive-setTimeout pattern so
 * a slow `invoke()` round-trip never queues overlapping calls — the next
 * timer is only armed after the previous response resolves.
 *
 * - Pauses automatically while `document.visibilityState === "hidden"` so
 *   the tray window does not burn CPU while the user is focused elsewhere.
 *   Resumes on the next `visibilitychange` event.
 * - Every mount/unmount cleans up both the pending timeout and the
 *   visibility listener; a re-mount therefore starts a single fresh poll
 *   loop, matching the TelemetrySection StrictMode guarantee.
 */
export function useRuntimeTelemetry(
  pollIntervalMs: number = DEFAULT_POLL_INTERVAL_MS,
): RuntimeTelemetrySnapshot {
  const [snapshot, setSnapshot] = useState<RuntimeTelemetrySnapshot>(INITIAL_SNAPSHOT);

  useEffect(() => {
    let mounted = true;
    // Pending re-arm timer. Non-null means "a poll is scheduled"; `inFlight`
    // means "a poll is currently awaiting its invoke()". At most one of the
    // two can be true at any moment — together they make re-entrancy safe.
    let timeoutId: number | null = null;
    let inFlight = false;

    const scheduleNext = () => {
      if (!mounted) return;
      // Do not re-arm while hidden — resume handler will kick off a fresh
      // tick once the page becomes visible again.
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
        setSnapshot(projectSnapshot(next));
      } catch (error) {
        if (!mounted) return;
        // Do not zero the snapshot on transient failure — a single missed
        // poll should not flicker the pill. Log so silent-catch is not
        // smuggled in.
        console.error("[LumaSync] useRuntimeTelemetry poll failed:", error);
      } finally {
        inFlight = false;
        scheduleNext();
      }
    };

    const handleVisibilityChange = () => {
      if (!mounted) return;
      if (document.visibilityState === "visible") {
        // Resume only when no timer is armed and no request is pending.
        // `scheduleNext` will re-arm on its own once the in-flight request
        // resolves; kicking off a second tick here would queue overlapping
        // invokes.
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
  }, [pollIntervalMs]);

  return snapshot;
}
