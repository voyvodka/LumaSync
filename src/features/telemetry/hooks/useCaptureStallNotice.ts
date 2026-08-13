import { useEffect, useState } from "react";

import { describeCaptureFailure, type CaptureFailureNotice } from "@/shared/contracts/capture";
import { isCaptureFailingNow } from "@/shared/contracts/telemetry";

import { subscribeTelemetry } from "../telemetrySource";

const POLL_INTERVAL_MS = 1000;

/** Mid-stream twin of the start-failure notice: the worker already returned
 *  `AMBILIGHT_MODE_STARTED`, so telemetry is the only carrier left. Un-timed
 *  unlike the start toast — a live condition clears on recovery, not a timer. */
export function useCaptureStallNotice(enabled: boolean): CaptureFailureNotice | null {
  const [notice, setNotice] = useState<CaptureFailureNotice | null>(null);

  useEffect(() => {
    if (!enabled) {
      setNotice(null);
      return;
    }

    return subscribeTelemetry(POLL_INTERVAL_MS, (next) => {
      // A failed tick leaves the last verdict standing; flipping to "recovered"
      // on an unreachable backend would be the opposite of the truth.
      if (!next.snapshot) return;
      const usb = next.snapshot.usb;
      setNotice(
        isCaptureFailingNow(usb) ? describeCaptureFailure(usb.lastCaptureErrorCode) : null,
      );
    });
  }, [enabled]);

  return notice;
}
