import { useCallback, useEffect, useRef } from "react";

import { saveShellState } from "@/features/shell/windowLifecycle";

import type { LightingModeConfig } from "../model/contracts";

const LIGHTING_MODE_PERSIST_DEBOUNCE_MS = 300;

/** Debounced `lightingMode → shellStore` writer. Flushes on pagehide,
 *  visibilitychange→hidden and unmount — a Cmd+R right after a slider
 *  move must not lose the write. */
export function useLightingModePersistence(): (mode: LightingModeConfig) => void {
  const timeoutRef = useRef<number | null>(null);
  const lastPendingModeRef = useRef<LightingModeConfig | null>(null);

  const schedulePersist = useCallback((mode: LightingModeConfig) => {
    lastPendingModeRef.current = mode;
    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    timeoutRef.current = window.setTimeout(() => {
      timeoutRef.current = null;
      const pending = lastPendingModeRef.current;
      lastPendingModeRef.current = null;
      if (pending) void saveShellState({ lightingMode: pending });
    }, LIGHTING_MODE_PERSIST_DEBOUNCE_MS);
  }, []);

  useEffect(() => {
    const flush = () => {
      if (timeoutRef.current !== null) {
        window.clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
      // Cleared before the write so a flush and a timer firing back-to-back
      // cannot double-write.
      const pending = lastPendingModeRef.current;
      lastPendingModeRef.current = null;
      if (pending) void saveShellState({ lightingMode: pending });
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      flush();
    };
  }, []);

  return schedulePersist;
}
