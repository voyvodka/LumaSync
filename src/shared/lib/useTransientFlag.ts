import { useCallback, useEffect, useRef, useState } from "react";

/** How long a persist-failure banner stays on screen before it self-dismisses. */
const DEFAULT_DURATION_MS = 3000;

export interface TransientFlag {
  active: boolean;
  raise: () => void;
  clear: () => void;
}

/** Self-clearing boolean. The timer ref is per call site: sharing one lets the
 *  path that raised last re-arm, and so cancel, the other's dismissal. */
export function useTransientFlag(durationMs: number = DEFAULT_DURATION_MS): TransientFlag {
  const [active, setActive] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const raise = useCallback(() => {
    setActive(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => { setActive(false); }, durationMs);
  }, [durationMs]);

  const clear = useCallback(() => {
    setActive(false);
  }, []);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return { active, raise, clear };
}
