import { useCallback, useEffect, useRef, useState } from "react";

import type { PreviewOpenFailure } from "../previewOpenFailure";

export const PREVIEW_OPEN_NOTICE_MS = 6_000;

export interface PreviewOpenNotice {
  notice: PreviewOpenFailure | null;
  report: (failure: PreviewOpenFailure) => void;
}

/**
 * Sole writer of the "LED preview did not open" toast. The tray action that
 * raises it usually fires with the main window hidden, so the countdown only
 * runs while the document is visible — otherwise the toast would expire
 * before anyone could read it.
 */
export function usePreviewOpenNotice(): PreviewOpenNotice {
  const [notice, setNotice] = useState<PreviewOpenFailure | null>(null);
  const timeoutRef = useRef<number | null>(null);

  const clearTimer = useCallback(() => {
    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const armTimer = useCallback(() => {
    clearTimer();
    if (document.visibilityState === "hidden") return;
    timeoutRef.current = window.setTimeout(() => {
      timeoutRef.current = null;
      setNotice(null);
    }, PREVIEW_OPEN_NOTICE_MS);
  }, [clearTimer]);

  const report = useCallback(
    (failure: PreviewOpenFailure) => {
      setNotice(failure);
      armTimer();
    },
    [armTimer],
  );

  useEffect(() => {
    if (notice === null) return;
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible" && timeoutRef.current === null) armTimer();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [notice, armTimer]);

  useEffect(() => clearTimer, [clearTimer]);

  return { notice, report };
}
