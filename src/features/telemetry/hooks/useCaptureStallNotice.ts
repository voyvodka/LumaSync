import { useEffect, useRef, useState } from "react";

import { describeCaptureFailure, type CaptureFailureNotice } from "@/shared/contracts/capture";
import { isCaptureFailingNow } from "@/shared/contracts/telemetry";

import { subscribeTelemetry } from "../telemetrySource";

const POLL_INTERVAL_MS = 1000;

function sameNotice(a: CaptureFailureNotice | null, b: CaptureFailureNotice | null): boolean {
  if (a === null || b === null) return a === b;
  return a.bucket === b.bucket && a.reason === b.reason;
}

/** Mid-stream twin of the start-failure notice: the worker already returned
 *  `AMBILIGHT_MODE_STARTED`, so telemetry is the only carrier left. Un-timed
 *  unlike the start toast — a live condition clears on recovery, not a timer. */
export function useCaptureStallNotice(enabled: boolean): CaptureFailureNotice | null {
  const [notice, setNotice] = useState<CaptureFailureNotice | null>(null);
  // Compared here rather than in a functional update: this hook sits in App,
  // and even a bailed-out update can cost it a render per tick.
  const lastRef = useRef<CaptureFailureNotice | null>(null);

  useEffect(() => {
    const publish = (verdict: CaptureFailureNotice | null) => {
      if (sameNotice(lastRef.current, verdict)) return;
      lastRef.current = verdict;
      setNotice(verdict);
    };

    if (!enabled) {
      publish(null);
      return;
    }

    return subscribeTelemetry(POLL_INTERVAL_MS, (next) => {
      // A failed tick leaves the last verdict standing; flipping to "recovered"
      // on an unreachable backend would be the opposite of the truth.
      if (!next.snapshot) return;
      const usb = next.snapshot.usb;
      publish(isCaptureFailingNow(usb) ? describeCaptureFailure(usb.lastCaptureErrorCode) : null);
    });
  }, [enabled]);

  return notice;
}
