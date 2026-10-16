import { useCallback, useState } from "react";

import { type FlashDeps, flashStrip, type FlashOutcome } from "@/features/device/state/stripFlash";
import { shellStore } from "@/features/persistence/shellStore";
import { primaryStrip, stripsOf } from "@/features/strips/model/stripSelectors";

export interface StripBlink {
  /** The room light being blinked, if one is. */
  busyId: string | null;
  /** The last blink that did not reach its strip, and why. */
  failure: { id: string; outcome: Exclude<FlashOutcome, "lit"> } | null;
  /** Lights the strip on `port` white for a moment, sized by its own layout. */
  blink: (id: string, port: string | null) => Promise<void>;
}

/** The View card's blink for a USB strip, or a screen through its backlight: the Devices page's flash. */
export function useStripBlink(deps?: FlashDeps): StripBlink {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [failure, setFailure] = useState<StripBlink["failure"]>(null);
  const blink = useCallback(
    async (id: string, port: string | null) => {
      setFailure(null);
      setBusyId(id);
      try {
        const strips = stripsOf(await shellStore.load());
        const strip = strips.find((s) => s.transport?.kind === "serial" && s.transport.portName === port) ?? primaryStrip(strips);
        const outcome = await flashStrip(strip?.layout, deps);
        if (outcome !== "lit") setFailure({ id, outcome });
      } catch (error) {
        console.error("[LumaSync] blinking a strip from the room failed:", error);
        setFailure({ id, outcome: "failed" });
      } finally {
        setBusyId(null);
      }
    },
    [deps],
  );
  return { busyId, failure, blink };
}
