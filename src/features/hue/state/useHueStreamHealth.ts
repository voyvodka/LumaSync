import { useEffect, useState, type RefObject } from "react";

import {
  LIGHTING_MODE_KIND,
  type LightingModeConfig,
} from "@/features/mode/model/contracts";
import type { LightingModeDispatcher } from "@/features/mode/state/useLightingModeDispatch";
import {
  HUE_RUNTIME_STATES,
  type HueRuntimeState,
  type HueRuntimeTarget,
} from "@/shared/contracts/hue";

import { readHueStreamStatus, subscribeHueStreamStatusInvalidation } from "../hueReadCache";

/**
 * Cadence while the stream is alive. NOT a local read: `get_hue_stream_status`
 * runs a full `check_hue_stream_readiness` round-trip against the bridge on
 * the alive path (`commands/hue/commands.rs`), so this is real bridge traffic
 * — hence the shared `readHueStreamStatus` cache.
 */
const HUE_STREAM_HEALTH_POLL_MS = 5_000;
/**
 * Cadence once the stream is dead. Polling continues so the target can be
 * restored without a mode transition; on THIS path the backend short-circuits
 * before any network call, so it costs one IPC hop and no bridge traffic.
 */
const HUE_STREAM_HEALTH_RECOVERY_POLL_MS = 15_000;

export interface HueStreamHealthInput {
  /** The only dep, deliberately a boolean rather than the target array. */
  hueTargetSelected: boolean;
  activeOutputTargetsRef: RefObject<HueRuntimeTarget[]>;
  lightingModeRef: RefObject<LightingModeConfig>;
  selectedOutputTargetsRef: RefObject<HueRuntimeTarget[]>;
  /** Called through a ref so re-applying never restarts the poll loop. */
  dispatchRef: RefObject<LightingModeDispatcher | null>;
  setActiveOutputTargets: (update: (prev: HueRuntimeTarget[]) => HueRuntimeTarget[]) => void;
}

export interface HueStreamHealth {
  /** Last state the backend reported; `null` until the first poll lands. */
  runtimeState: HueRuntimeState | null;
}

/**
 * Whether a Hue session the app still owns is actually delivering frames.
 * RECONNECTING keeps "hue" in `activeOutputTargets` — the backend is retrying
 * and a bridge can stay unreachable for hours — so membership alone would
 * report a stream that sends nothing.
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

// Two-way Hue health reconciler. The restore direction is the fix: the poll
// used to `return` on the first dead reading, stranding "hue" out of
// `activeOutputTargets` forever so every Solid colour change was dropped.
export function useHueStreamHealth({
  hueTargetSelected,
  activeOutputTargetsRef,
  lightingModeRef,
  selectedOutputTargetsRef,
  dispatchRef,
  setActiveOutputTargets,
}: HueStreamHealthInput): HueStreamHealth {
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

        const backendDead =
          result.status.state === HUE_RUNTIME_STATES.FAILED ||
          result.status.state === HUE_RUNTIME_STATES.IDLE;
        const targetActive = activeOutputTargetsRef.current.includes("hue");
        nextDelayMs = backendDead
          ? HUE_STREAM_HEALTH_RECOVERY_POLL_MS
          : HUE_STREAM_HEALTH_POLL_MS;

        if (backendDead && targetActive) {
          console.warn(
            `[LumaSync] Hue stream health check: backend reported ${result.status.state}. ` +
              `Message: ${result.status.message}. Removing "hue" from active targets.`,
          );
          setActiveOutputTargets((prev) => prev.filter((t) => t !== "hue"));
        } else if (!backendDead && !targetActive) {
          const mode = lightingModeRef.current;
          if (mode.kind !== LIGHTING_MODE_KIND.OFF) {
            console.info(
              `[LumaSync] Hue stream recovered (${result.status.state}). Restoring "hue" as an active target.`,
            );
            setActiveOutputTargets((prev) =>
              prev.includes("hue") ? prev : [...prev, "hue" as HueRuntimeTarget],
            );
            // The running ambilight worker captured `hue_output=None` when the
            // stream was down; only a forced re-apply hands it the live context.
            void dispatchRef.current?.(
              { ...mode, targets: selectedOutputTargetsRef.current },
              { force: true },
            ).catch((error) => {
              console.error("[LumaSync] Hue recovery mode re-apply failed:", error);
            });
          }
        }
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
    // a held Failed must not outlive the mutation that may have ended it. Only
    // the reading is dropped; the next poll still owns the target reconcile.
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
    // ONLY dep on purpose — taking `dispatch` or the target array itself would
    // restart the loop on every identity change and storm the bridge.
  }, [hueTargetSelected]);

  return { runtimeState };
}
