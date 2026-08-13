import { useCallback, useEffect, useRef, useState } from "react";

import { isHueSolidColorUnapplied, type HueSolidColorStatusCode } from "@/shared/contracts/hue";

const HUE_COLOR_NOTICE_MS = 5_000;

export interface HueSolidColorNotice {
  /** Set when a Solid colour was accepted by the runtime but never reached the bridge. */
  notice: HueSolidColorStatusCode | null;
  report: (code: string) => void;
}

/** Sole writer of the Hue "colour not applied" toast. */
export function useHueSolidColorNotice(): HueSolidColorNotice {
  const [notice, setNotice] = useState<HueSolidColorStatusCode | null>(null);
  const timeoutRef = useRef<number | null>(null);

  // Surfaces the one outcome the user cannot otherwise see: the picker moved,
  // the bulbs did not. Queued-pending-stream stays silent — it self-resolves.
  const report = useCallback((code: string) => {
    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    if (!isHueSolidColorUnapplied(code)) {
      setNotice(null);
      return;
    }
    console.warn(`[LumaSync] Hue solid color not applied: ${code}`);
    setNotice(code as HueSolidColorStatusCode);
    timeoutRef.current = window.setTimeout(() => {
      timeoutRef.current = null;
      setNotice(null);
    }, HUE_COLOR_NOTICE_MS);
  }, []);

  useEffect(
    () => () => {
      if (timeoutRef.current !== null) {
        window.clearTimeout(timeoutRef.current);
      }
    },
    [],
  );

  return { notice, report };
}
