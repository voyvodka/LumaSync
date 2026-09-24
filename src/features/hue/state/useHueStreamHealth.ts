import { useEffect, useState } from "react";

import { HUE_RUNTIME_STATES, type HueRuntimeState } from "@/shared/contracts/hue";

import { readHueStreamStatus, subscribeHueStreamStatusInvalidation } from "../hueReadCache";

/**
 * Cadence while the stream is alive. NOT a local read: `get_hue_stream_status`
 * runs a full `check_hue_stream_readiness` round-trip against the bridge on
 * the alive path (`commands/hue/commands.rs`), so this is real bridge traffic
 * — hence the shared `readHueStreamStatus` cache.
 */
const HUE_STREAM_HEALTH_POLL_MS = 5_000;
/**
 * Cadence once the stream is dead. Polling continues so the chip sees it come
 * back; on THIS path the backend short-circuits before any network call, so it
 * costs one IPC hop and no bridge traffic.
 */
const HUE_STREAM_HEALTH_RECOVERY_POLL_MS = 15_000;

export interface HueStreamHealthInput {
  /** The only dep, deliberately a boolean rather than the target array. */
  hueTargetSelected: boolean;
}

export interface HueStreamHealth {
  /** Last state the backend reported; `null` until the first poll lands. */
  runtimeState: HueRuntimeState | null;
}

/**
 * Whether a Hue session the app still owns is actually delivering frames.
 * RECONNECTING keeps "hue" in the snapshot's `activeTargets` — the backend is
 * retrying and a bridge can stay unreachable for hours — so membership alone
 * would report a stream that sends nothing.
 */
export function isHueSessionReconnecting(
  sessionActive: boolean,
  runtimeState: HueRuntimeState | null,
): boolean {
  return sessionActive && runtimeState === HUE_RUNTIME_STATES.RECONNECTING;
}

/** The backend gave up on the Hue stream. Only ever seen while Hue is a
 * selected output: the hook clears its state when it is not. */
export function isHueStreamFailed(runtimeState: HueRuntimeState | null): boolean {
  return runtimeState === HUE_RUNTIME_STATES.FAILED;
}

/**
 * Whether the backend reports no live stream: failed, or idle. The snapshot
 * keeps "hue" driven until a stop confirms, so the chip reads this beside it.
 */
export function isHueStreamDead(runtimeState: HueRuntimeState | null): boolean {
  return runtimeState === HUE_RUNTIME_STATES.FAILED || runtimeState === HUE_RUNTIME_STATES.IDLE;
}

/**
 * Reads the Hue stream's health for the status chip. Read-only: the running
 * worker follows the live stream slot through every reconnect, so a stream
 * that comes back needs no re-apply (docs/architecture/hue.md), and what is
 * driven is the runtime snapshot's to say.
 */
export function useHueStreamHealth({ hueTargetSelected }: HueStreamHealthInput): HueStreamHealth {
  const [runtimeState, setRuntimeState] = useState<HueRuntimeState | null>(null);

  useEffect(() => {
    if (!hueTargetSelected) {
      setRuntimeState(null);
      return;
    }

    let active = true;
    let timerId: number | null = null;
    let inFlight = false;

    const poll = async () => {
      if (!active) return;
      if (inFlight) return;
      // Visibility-aware: the tray window can be hidden indefinitely with the
      // React tree mounted. Skip backend polling while hidden and resume with
      // an immediate tick on `visibilitychange`.
      if (document.visibilityState === "hidden") return;
      inFlight = true;
      let nextDelayMs = HUE_STREAM_HEALTH_POLL_MS;
      try {
        const result = await readHueStreamStatus();
        if (!active) return;
        setRuntimeState(result.status.state);
        nextDelayMs = isHueStreamDead(result.status.state)
          ? HUE_STREAM_HEALTH_RECOVERY_POLL_MS
          : HUE_STREAM_HEALTH_POLL_MS;
      } catch (err) {
        console.warn("[LumaSync] Hue stream health poll failed (transient, keeping target):", err);
      } finally {
        inFlight = false;
      }

      scheduleNext(nextDelayMs);
    };

    const scheduleNext = (delayMs: number) => {
      if (!active) return;
      if (document.visibilityState === "hidden") return;
      if (timerId !== null) return;
      timerId = window.setTimeout(() => {
        timerId = null;
        void poll();
      }, delayMs);
    };

    const handleVisibilityChange = () => {
      if (!active) return;
      if (document.visibilityState === "visible" && timerId === null && !inFlight) {
        void poll();
      }
    };

    // `Failed` holds until a start or stop, and the dead-stream cadence is slow:
    // a held Failed must not outlive the mutation that may have ended it.
    const unsubscribeInvalidation = subscribeHueStreamStatusInvalidation(() => {
      if (!active) return;
      setRuntimeState((prev) => (prev === HUE_RUNTIME_STATES.FAILED ? null : prev));
    });

    void poll();
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      active = false;
      unsubscribeInvalidation();
      if (timerId !== null) {
        window.clearTimeout(timerId);
        timerId = null;
      }
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
    // ONLY dep on purpose — taking the target array itself would restart the
    // loop on every identity change and storm the bridge.
  }, [hueTargetSelected]);

  return { runtimeState };
}
