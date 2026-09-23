import { useEffect, useRef } from "react";

import { SCREEN_CAPTURE_PERMISSION_STATUS } from "@/shared/contracts/capture";

import { getScreenCapturePermission } from "../captureApi";

/** How often a standing permission notice asks again while the window is visible. */
export const CAPTURE_PERMISSION_RECHECK_MS = 3_000;

/**
 * While the permission notice stands, re-asks the non-prompting probe — on an
 * interval, and at once when the window comes back from System Settings — and
 * reports when it answers GRANTED. Only GRANTED counts: the probe reads a
 * failed call as NOT_REQUIRED, which must not clear a notice that is still true.
 */
export function useCapturePermissionRecheck(active: boolean, onGranted: () => void): void {
  const onGrantedRef = useRef(onGranted);
  useEffect(() => {
    onGrantedRef.current = onGranted;
  }, [onGranted]);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let inFlight = false;
    const check = async () => {
      if (inFlight || document.visibilityState === "hidden") return;
      inFlight = true;
      try {
        const result = await getScreenCapturePermission();
        if (!cancelled && result.code === SCREEN_CAPTURE_PERMISSION_STATUS.GRANTED) onGrantedRef.current();
      } finally {
        inFlight = false;
      }
    };
    const onReturn = () => void check();
    const onVisibility = () => {
      if (document.visibilityState === "visible") void check();
    };
    const timerId = window.setInterval(onReturn, CAPTURE_PERMISSION_RECHECK_MS);
    window.addEventListener("focus", onReturn);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      window.clearInterval(timerId);
      window.removeEventListener("focus", onReturn);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [active]);
}
