import { useCallback, useEffect, useRef, useState } from "react";

import type { UpdaterStatusCode } from "@/shared/contracts/updater";

export const UPDATE_CHECK_FAILED_NOTICE_MS = 8_000;

/** A fresh object per failure, so the notice queue counts each as a new occurrence. */
export interface UpdateCheckFailure {
  code?: UpdaterStatusCode;
  message: string;
}

export interface UpdateCheckFailedNotice {
  notice: UpdateCheckFailure | null;
  report: (failure: UpdateCheckFailure) => void;
  /** Keeps the notice up with no countdown, while the check it offers runs. */
  hold: () => void;
  clear: () => void;
}

/**
 * Sole writer of the "could not check for updates" notice. The startup check
 * usually finishes with the window still in the tray, so the countdown only
 * runs while the document is visible.
 */
export function useUpdateCheckFailedNotice(): UpdateCheckFailedNotice {
  const [notice, setNotice] = useState<UpdateCheckFailure | null>(null);
  const timeoutRef = useRef<number | null>(null);
  const heldRef = useRef(false);

  const clearTimer = useCallback(() => {
    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const armTimer = useCallback(() => {
    clearTimer();
    if (heldRef.current || document.visibilityState === "hidden") return;
    timeoutRef.current = window.setTimeout(() => {
      timeoutRef.current = null;
      setNotice(null);
    }, UPDATE_CHECK_FAILED_NOTICE_MS);
  }, [clearTimer]);

  const report = useCallback(
    (failure: UpdateCheckFailure) => {
      heldRef.current = false;
      setNotice(failure);
      armTimer();
    },
    [armTimer],
  );

  const hold = useCallback(() => {
    heldRef.current = true;
    clearTimer();
  }, [clearTimer]);

  const clear = useCallback(() => {
    heldRef.current = false;
    clearTimer();
    setNotice(null);
  }, [clearTimer]);

  useEffect(() => {
    if (notice === null) return;
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible" && timeoutRef.current === null) armTimer();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [notice, armTimer]);

  useEffect(() => clearTimer, [clearTimer]);

  return { notice, report, hold, clear };
}
