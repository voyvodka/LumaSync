import { useEffect, useRef, useState } from "react";

import { TELEMETRY_QUEUE_HEALTH, type FullTelemetrySnapshot } from "@/shared/contracts/telemetry";
import { subscribeTelemetry } from "../telemetrySource";

/**
 * Snapshot shape surfaced to consumers (StatusBar FPS pill, future readouts).
 *
 * `fps` is `null` when Ambilight is not actively pushing frames — the
 * StatusBar renders an "FPS —" placeholder in that case instead of a misleading
 * zero. Once ambilight starts, the snapshot exposes the backend capture FPS.
 *
 * `latencyMs` mirrors `frameLatencyMs` from the backend telemetry contract.
 */
export interface RuntimeTelemetrySnapshot {
  /** Backend capture FPS, or `null` when no frames are flowing. */
  fps: number | null;
  /** EWMA of capture+send cost in milliseconds, or `null` before first frame. */
  latencyMs: number | null;
  /**
   * Whether the output keeps up, or `null` when no frames are flowing. Judged from the queue and
   * the link, never from `fps`: capture counts distinct frames, so a still screen reads far below
   * its target with nothing wrong.
   */
  health: PipelineHealth | null;
  /** `performance.now()` when the values last changed — an identical tick keeps
   *  the previous snapshot, so the status bar does not re-render each second. */
  timestamp: number;
}

/** `strained`: the link limits the effect or frames start to be overwritten; `behind`: most are. */
export type PipelineHealth = "ok" | "strained" | "behind";

const DEFAULT_POLL_INTERVAL_MS = 1000;

const INITIAL_SNAPSHOT: RuntimeTelemetrySnapshot = {
  fps: null,
  latencyMs: null,
  health: null,
  timestamp: 0,
};

/**
 * Normalize a raw telemetry payload into the StatusBar-facing snapshot. A
 * `captureFps` of exactly 0 is treated as "inactive" (null) so consumers can
 * render a neutral placeholder instead of a misleading `0 FPS` chip.
 */
function projectSnapshot(dto: FullTelemetrySnapshot): RuntimeTelemetrySnapshot {
  const { captureFps, sendFps, queueHealth, linkConstrained } = dto.usb;
  const active = captureFps > 0 || sendFps > 0;

  return {
    fps: active ? captureFps : null,
    latencyMs: active ? dto.usb.frameLatencyMs : null,
    health: active ? healthOf(queueHealth, linkConstrained) : null,
    timestamp: performance.now(),
  };
}

function healthOf(queueHealth: FullTelemetrySnapshot["usb"]["queueHealth"], linkConstrained: boolean): PipelineHealth {
  if (queueHealth === TELEMETRY_QUEUE_HEALTH.CRITICAL) return "behind";
  if (queueHealth === TELEMETRY_QUEUE_HEALTH.WARNING || linkConstrained) return "strained";
  return "ok";
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
  const lastRef = useRef<RuntimeTelemetrySnapshot>(INITIAL_SNAPSHOT);

  useEffect(() => {
    if (!enabled) {
      // Reset to the inactive placeholder so consumers that read the
      // snapshot after a mode-off transition do not keep stale FPS values
      // on screen.
      lastRef.current = INITIAL_SNAPSHOT;
      setSnapshot(INITIAL_SNAPSHOT);
      return;
    }

    return subscribeTelemetry(pollIntervalMs, (next) => {
      // A failed tick keeps the previous snapshot on screen rather than
      // flickering the pill to zero.
      if (!next.snapshot) return;
      const projected = projectSnapshot(next.snapshot);
      const prev = lastRef.current;
      if (
        prev.fps === projected.fps &&
        prev.latencyMs === projected.latencyMs &&
        prev.health === projected.health
      ) {
        return;
      }
      lastRef.current = projected;
      setSnapshot(projected);
    });
  }, [pollIntervalMs, enabled]);

  return snapshot;
}
