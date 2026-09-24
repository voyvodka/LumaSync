import { useMemo } from "react";

import { describeCaptureFailure, type CaptureFailureNotice } from "@/shared/contracts/capture";
import type { RuntimeHealth } from "@/shared/contracts/telemetry";

import { useRuntimeHealth } from "../runtimeHealthSource";

const selectCaptureFailure = (health: RuntimeHealth) => health.captureFailureCode;

/** Mid-stream twin of the start-failure notice: the worker already returned
 *  `AMBILIGHT_MODE_STARTED`, so the pushed runtime health is the only carrier
 *  left — never a poll, so it holds with stats for nerds off. Un-timed unlike
 *  the start toast — a live condition clears on recovery, not a timer. */
export function useCaptureStallNotice(enabled: boolean): CaptureFailureNotice | null {
  // A selected string, so this hook sits in App at no cost per push: App
  // re-renders only when the failure itself starts, changes or clears.
  const failureCode = useRuntimeHealth(selectCaptureFailure);
  return useMemo(
    () => (enabled && failureCode !== null ? describeCaptureFailure(failureCode) : null),
    [enabled, failureCode],
  );
}
