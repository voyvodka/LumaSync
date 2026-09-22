// The one Hue retry the frontend makes on its own: a boot restore the bridge
// refused because its entertainment area was still held, usually by the session
// an unclean exit left behind. A narrow exception to "no background Hue retry"
// — see docs/architecture/hue.md.

import { useCallback, useEffect, useRef, useState } from "react";

import {
  checkHueStreamReadiness,
  type HueStreamReadinessResponse,
} from "@/features/hue/hueOnboardingApi";
import type { HueStartConfig } from "@/features/hue/model/hueStartConfig";
import { HUE_READINESS_REASON, HUE_RUNTIME_STATUS, HUE_STATUS } from "@/shared/contracts/hue";

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

export interface BootHueRetry {
  notice: BootHueRetryNotice | null;
  schedule: (mode: LightingModeConfig, config: HueStartConfig) => void;
  cancel: (reason: string) => void;
}

/**
 * Owns the notice and the single retry. `resume` must read live state, since it
 * runs well after the render that scheduled it.
 */
export function useBootHueRetry(resume: (mode: LightingModeConfig) => Promise<void>): BootHueRetry {
  const [notice, setNotice] = useState<BootHueRetryNotice | null>(null);
  const resumeRef = useRef(resume);
  useEffect(() => {
    resumeRef.current = resume;
  }, [resume]);

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

  const schedule = useCallback((mode: LightingModeConfig, config: HueStartConfig) => {
    cancelBootHueRetry("superseded by a new boot retry");
    const controller = new AbortController();
    pending.add(controller);
    // Covers a cancel from outside the hook (`stopHue`).
    controller.signal.addEventListener("abort", () => setNotice(null), { once: true });

    void (async () => {
      const outcome = await waitForHueAreaRelease({
        probe: () => checkHueStreamReadiness(config.bridgeIp, config.username, config.areaId),
        signal: controller.signal,
        onBusy: () => {
          console.info("[LumaSync] Boot Hue retry: the area is still held; waiting for the bridge to free it.");
          setNotice("waiting");
        },
      });
      pending.delete(controller);
      if (outcome === "cancelled") return;
      if (outcome === "timeout") {
        console.warn(
          `[LumaSync] Boot Hue retry: the area was still held after ${BOOT_HUE_RETRY_WINDOW_MS} ms; leaving ${mode.kind} off.`,
        );
        setNotice("gaveUp");
        return;
      }
      setNotice(null);
      if (outcome === "notBusy") {
        console.warn("[LumaSync] Boot Hue retry: the refusal was not a busy area; not retrying.");
        return;
      }
      console.info(`[LumaSync] Boot Hue retry: the area is free; resuming ${mode.kind}.`);
      try {
        await resumeRef.current(mode);
      } catch (err) {
        console.error("[LumaSync] Boot Hue retry: resuming the restored mode failed:", err);
      }
    })();
  }, []);

  return { notice, schedule, cancel };
}
