import { useCallback, useEffect, useRef, useState } from "react";

import { identifyHueLights } from "@/features/hue/hueOnboardingApi";
import { HUE_IDENTIFY_SIGNAL_MS, HUE_IDENTIFY_STATUS, type HueIdentifyStatus } from "@/shared/contracts/hue";
import { parseCommandError } from "@/shared/contracts/status";

/** Shorter than this, a press that came back at once would flash the button and read as nothing. */
const MIN_BUSY_MS = 600;

export interface HueIdentify {
  /** Whose lights are blinking now; one at a time. */
  busyId: string | null;
  /** The last failure's code, cleared by the next attempt. */
  failure: { id: string; code: string } | null;
  identify: (id: string, lightIds: readonly string[]) => void;
}

/** Blinks a light from the room. The key is left empty: the command reads it from the keychain,
 *  so the room never holds a credential. */
export function useHueIdentify(bridgeIp: string | null): HueIdentify {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [failure, setFailure] = useState<HueIdentify["failure"]>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);

  // Set in the body too: StrictMode runs the cleanup once on a dev mount, and a flag only ever
  // cleared would leave every press waiting forever.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const identify = useCallback(
    (id: string, lightIds: readonly string[]) => {
      if (!bridgeIp || lightIds.length === 0 || busyId) return;
      setBusyId(id);
      setFailure(null);
      const started = Date.now();
      const settle = (status: HueIdentifyStatus | null, message?: string) => {
        if (!mounted.current) return;
        const blinked = status?.code === HUE_IDENTIFY_STATUS.OK || status?.code === HUE_IDENTIFY_STATUS.PARTIAL;
        if (status?.code !== HUE_IDENTIFY_STATUS.OK) {
          const code = status?.code ?? HUE_IDENTIFY_STATUS.FAILED;
          console.warn(`[LumaSync] Hue identify failed (${code}): ${status?.details ?? status?.message ?? message ?? ""}`);
          setFailure({ id, code });
        }
        const hold = blinked ? HUE_IDENTIFY_SIGNAL_MS : MIN_BUSY_MS;
        timer.current = setTimeout(() => {
          if (mounted.current) setBusyId(null);
        }, Math.max(hold - (Date.now() - started), 0));
      };
      identifyHueLights(bridgeIp, "", [...lightIds]).then(
        (status) => settle(status),
        (error: unknown) => settle(null, parseCommandError(error).message),
      );
    },
    [bridgeIp, busyId],
  );

  return { busyId, failure, identify };
}
