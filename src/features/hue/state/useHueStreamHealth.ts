import { HUE_RUNTIME_STATES, type HueRuntimeState } from "@/shared/contracts/hue";

import { selectHueStreamState, useHueHealth } from "./useHueHealth";

export interface HueStreamHealthInput {
  /** The only input, deliberately a boolean rather than the target array. */
  hueTargetSelected: boolean;
}

export interface HueStreamHealth {
  /** Last state the backend reported; `null` until the first answer, and
   * whenever Hue is not a selected output. */
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
 * selected output: the hook reports nothing when it is not. */
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
 * The Hue stream's health for the status chip, read from the health
 * monitor's snapshot. Read-only: the running worker follows the live stream
 * slot through every reconnect, so a stream that comes back needs no re-apply
 * (docs/architecture/hue.md), and what is driven is the runtime snapshot's to
 * say. A held `Failed` cannot outlive the start or stop that ended it: Rust
 * publishes the runtime's new state as that command returns.
 */
export function useHueStreamHealth({ hueTargetSelected }: HueStreamHealthInput): HueStreamHealth {
  const runtimeState = useHueHealth(selectHueStreamState);
  return { runtimeState: hueTargetSelected ? runtimeState : null };
}
