import { useEffect, useState } from "react";

import type { FullTelemetrySnapshot } from "@/shared/contracts/telemetry";
import { subscribeTelemetry } from "../telemetrySource";

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
 * StatusBar-facing projection of the shared telemetry loop in
 * `../telemetrySource` (cadence, visibility pausing and the in-flight guard
 * all live there). With `enabled === false` the hook holds `INITIAL_SNAPSHOT`
 * and contributes no polling — flipping it back re-subscribes.
 */
export function useRuntimeTelemetry(
  pollIntervalMs: number = DEFAULT_POLL_INTERVAL_MS,
  enabled: boolean = true,
): RuntimeTelemetrySnapshot {
  const [snapshot, setSnapshot] = useState<RuntimeTelemetrySnapshot>(INITIAL_SNAPSHOT);

  useEffect(() => {
    if (!enabled) {
      // Reset to the inactive placeholder so consumers that read the
      // snapshot after a mode-off transition do not keep stale FPS values
      // on screen.
      setSnapshot(INITIAL_SNAPSHOT);
      return;
    }

    return subscribeTelemetry(pollIntervalMs, (next) => {
      // A failed tick keeps the previous snapshot on screen rather than
      // flickering the pill to zero.
      if (next.snapshot) setSnapshot(projectSnapshot(next.snapshot));
    });
  }, [pollIntervalMs, enabled]);

  return snapshot;
}
