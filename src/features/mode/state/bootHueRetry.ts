// The one Hue retry the frontend makes on its own: a boot restore the bridge
// refused, or ran on USB without Hue, because its entertainment area was still held, usually by the session
// an unclean exit left behind. A narrow exception to "no background Hue retry"
// — see docs/architecture/hue.md.

import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";

import {
  checkHueStreamReadiness,
  type HueStreamReadinessResponse,
} from "@/features/hue/hueOnboardingApi";
import type { HueStartConfig } from "@/features/hue/model/hueStartConfig";
import { HUE_READINESS_REASON, HUE_RUNTIME_STATUS, HUE_STATUS } from "@/shared/contracts/hue";
import { HUE_LEFT_OUT_REASON, type HueLeftOutReason } from "@/shared/contracts/lighting";

import type { LightingModeConfig } from "../model/contracts";

/** The readiness loop's own cadence while a streamer holds the area. */
export const BOOT_HUE_RETRY_POLL_MS = 3_000;

/** The bridge drops a silent session after ~10 s; after a killed process it took 10–20 s. */
export const BOOT_HUE_RETRY_WINDOW_MS = 25_000;

/** Same length as the other notices that ask the user to act. */
export const BOOT_HUE_RETRY_GAVE_UP_NOTICE_MS = 8_000;

/**
 * Whether a refused boot start could be a busy area. Only the readiness gate's
 * code qualifies; it also covers an unreachable bridge or an empty area, so
 * {@link readHueAreaVerdict} decides. An auth code never qualifies.
 */
export function isHueBusyCandidate(startCode: string | undefined): boolean {
  return startCode === HUE_RUNTIME_STATUS.CONFIG_NOT_READY_GATE_BLOCKED;
}

export type HueAreaVerdict = "busy" | "free" | "other";

/**
 * Busy means the active streamer is the *only* thing blocking the area — one
 * that also has no channels would still refuse once the streamer lets go.
 */
export function readHueAreaVerdict(response: HueStreamReadinessResponse): HueAreaVerdict {
  const { status, readiness } = response;
  if (status.code === HUE_STATUS.STREAM_READY && readiness.ready) return "free";
  if (
    status.code === HUE_STATUS.STREAM_NOT_READY &&
    readiness.reasons.length === 1 &&
    readiness.reasons[0] === HUE_READINESS_REASON.ACTIVE_STREAMER
  ) {
    return "busy";
  }
  return "other";
}

export type HueReleaseWaitOutcome = "free" | "timeout" | "notBusy" | "cancelled";

export interface HueReleaseWaitInput {
  probe: () => Promise<HueStreamReadinessResponse>;
  signal: AbortSignal;
  /** Fires once, when the first probe confirms the area is busy. */
  onBusy: () => void;
  pollMs?: number;
  windowMs?: number;
  now?: () => number;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      window.clearTimeout(timerId);
      resolve();
    };
    const timerId = window.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Polls readiness until the area frees up, stops being merely busy, or the window closes. */
export async function waitForHueAreaRelease({
  probe,
  signal,
  onBusy,
  pollMs = BOOT_HUE_RETRY_POLL_MS,
  windowMs = BOOT_HUE_RETRY_WINDOW_MS,
  now = () => Date.now(),
}: HueReleaseWaitInput): Promise<HueReleaseWaitOutcome> {
  const startedAt = now();
  let busySeen = false;
  for (;;) {
    if (signal.aborted) return "cancelled";
    let verdict: HueAreaVerdict;
    try {
      verdict = readHueAreaVerdict(await probe());
    } catch (err) {
      console.error("[LumaSync] Boot Hue retry: readiness probe failed:", err);
      verdict = "other";
    }
    if (signal.aborted) return "cancelled";
    if (verdict === "free") return "free";
    // Unreachable, re-pair, an unusable area: none of these clear by waiting.
    if (verdict === "other") return "notBusy";
    if (!busySeen) {
      busySeen = true;
      onBusy();
    }
    if (now() - startedAt + pollMs > windowMs) return "timeout";
    await sleep(pollMs, signal);
  }
}

// Module-level so `stopHue` can cancel from any tree, the way
// `stop_hue_stream` cancels the backend's reconnect retry.
const pending = new Set<AbortController>();

/** Cancels a pending boot retry, if any. Safe to call when none is pending. */
export function cancelBootHueRetry(reason: string): void {
  if (pending.size === 0) return;
  console.info(`[LumaSync] Boot Hue retry cancelled: ${reason}`);
  for (const controller of pending) controller.abort();
  pending.clear();
}

export type BootHueRetryNotice = "waiting" | "gaveUp";

/**
 * What the retry does once the area frees. `resume` re-runs a restore that
 * ended Off; `rejoin` adds Hue back to a `[usb, hue]` restore running on USB
 * alone. `leftOut` is the notice that restore held back, raised instead when
 * the refusal turns out not to be a busy area.
 */
export type BootHueRetryPlan =
  | { type: "resume"; mode: LightingModeConfig }
  | { type: "rejoin"; leftOut: HueLeftOutReason };

export interface BootHueRetryActions {
  /** Must read live state: it runs well after the render that scheduled it. */
  resume: (mode: LightingModeConfig) => Promise<void>;
  /** Adds Hue to the running mode the way the user's own toggle does. Reads live state too. */
  rejoin: () => Promise<void>;
  /** A rejoin speaks through the left-out notice, since USB is already running. */
  setHueLeftOut: Dispatch<SetStateAction<HueLeftOutReason | null>>;
}

export interface BootHueRetry {
  notice: BootHueRetryNotice | null;
  schedule: (plan: BootHueRetryPlan, config: HueStartConfig) => void;
  cancel: (reason: string) => void;
  /** A rejoin is waiting; any output choice the user makes supersedes it. */
  isRejoinPending: () => boolean;
}

/** Owns the resume notice and the single retry. */
export function useBootHueRetry(actions: BootHueRetryActions): BootHueRetry {
  const [notice, setNotice] = useState<BootHueRetryNotice | null>(null);
  const actionsRef = useRef(actions);
  useEffect(() => {
    actionsRef.current = actions;
  }, [actions]);
  const rejoinRef = useRef<AbortController | null>(null);

  useEffect(() => () => cancelBootHueRetry("shell unmounted"), []);

  useEffect(() => {
    if (notice !== "gaveUp") return;
    const timerId = window.setTimeout(() => setNotice(null), BOOT_HUE_RETRY_GAVE_UP_NOTICE_MS);
    return () => window.clearTimeout(timerId);
  }, [notice]);

  const cancel = useCallback((reason: string) => {
    cancelBootHueRetry(reason);
    setNotice(null);
  }, []);

  const isRejoinPending = useCallback(() => rejoinRef.current !== null, []);

  const schedule = useCallback((plan: BootHueRetryPlan, config: HueStartConfig) => {
    cancelBootHueRetry("superseded by a new boot retry");
    const controller = new AbortController();
    pending.add(controller);
    if (plan.type === "rejoin") rejoinRef.current = controller;
    const settle = () => {
      pending.delete(controller);
      if (rejoinRef.current === controller) rejoinRef.current = null;
    };
    // Covers a cancel from outside the hook (`stopHue`). A cancelled rejoin will
    // not add Hue, so "joins by itself" would be false; a left-out notice with
    // any other reason belongs to whoever raised it.
    controller.signal.addEventListener(
      "abort",
      () => {
        settle();
        if (plan.type === "rejoin") {
          actionsRef.current.setHueLeftOut((prev) => (prev === HUE_LEFT_OUT_REASON.BUSY ? null : prev));
        } else {
          setNotice(null);
        }
      },
      { once: true },
    );
    const what = plan.type === "rejoin" ? "adding Hue back" : `resuming ${plan.mode.kind}`;

    void (async () => {
      const outcome = await waitForHueAreaRelease({
        probe: () => checkHueStreamReadiness(config.bridgeIp, config.username, config.areaId),
        signal: controller.signal,
        onBusy: () => {
          console.info("[LumaSync] Boot Hue retry: the area is still held; waiting for the bridge to free it.");
          if (plan.type === "rejoin") actionsRef.current.setHueLeftOut(HUE_LEFT_OUT_REASON.BUSY);
          else setNotice("waiting");
        },
      });
      settle();
      if (outcome === "cancelled") return;
      if (outcome === "timeout") {
        console.warn(
          `[LumaSync] Boot Hue retry: the area was still held after ${BOOT_HUE_RETRY_WINDOW_MS} ms; not ${what}.`,
        );
        if (plan.type === "rejoin") actionsRef.current.setHueLeftOut(HUE_LEFT_OUT_REASON.BUSY_GAVE_UP);
        else setNotice("gaveUp");
        return;
      }
      if (outcome === "notBusy") {
        console.warn("[LumaSync] Boot Hue retry: the refusal was not a busy area; not retrying.");
        if (plan.type === "rejoin") actionsRef.current.setHueLeftOut(plan.leftOut);
        else setNotice(null);
        return;
      }
      console.info(`[LumaSync] Boot Hue retry: the area is free; ${what}.`);
      // Cleared first, so a notice the add raises for itself is the one that stays.
      if (plan.type === "rejoin") actionsRef.current.setHueLeftOut(null);
      else setNotice(null);
      try {
        if (plan.type === "rejoin") await actionsRef.current.rejoin();
        else await actionsRef.current.resume(plan.mode);
      } catch (err) {
        console.error(`[LumaSync] Boot Hue retry: ${what} failed:`, err);
      }
    })();
  }, []);

  return { notice, schedule, cancel, isRejoinPending };
}
