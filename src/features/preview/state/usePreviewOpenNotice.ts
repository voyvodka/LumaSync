import { useCallback, useEffect, useRef, useState } from "react";

import { isWindowVisible, subscribeWindowVisible } from "@/features/shell/windowVisibility";

import type { PreviewOpenFailure } from "../previewOpenFailure";

export const PREVIEW_OPEN_NOTICE_MS = 6_000;

export interface PreviewOpenNotice {
  notice: PreviewOpenFailure | null;
  report: (failure: PreviewOpenFailure) => void;
}

/**
 * Sole writer of the "LED preview did not open" toast. The tray action that
 * raises it usually fires with the main window hidden, so the countdown only
 * runs while the window is on screen — otherwise the toast would expire
 * before anyone could read it. The window, not the document: WebView2 keeps
 * the document "visible" in the tray.
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
    if (!isWindowVisible()) return;
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

  // Hidden again before it ran out, it waits for the next look in full.
  useEffect(() => {
    if (notice === null) return;
    return subscribeWindowVisible((visible) => {
      if (!visible) clearTimer();
      else if (timeoutRef.current === null) armTimer();
    });
  }, [notice, armTimer, clearTimer]);

  useEffect(() => clearTimer, [clearTimer]);

  return { notice, report };
}
