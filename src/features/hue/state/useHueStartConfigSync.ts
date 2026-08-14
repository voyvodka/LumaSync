import { useEffect } from "react";

import { shellStore } from "@/features/persistence/shellStore";

import { hueCredentialEvents } from "../hueCredentialEvents";
import { toHueStartConfig, type HueStartConfig } from "../model/hueStartConfig";

/** Re-projects the persisted pairing whenever it changes. Without this the
 *  mirror only moved on boot and on a mode change, so pairing a bridge left
 *  every consumer — the reachability probe, the USB reconciler — on `null`
 *  until the user happened to switch modes. */
export function useHueStartConfigSync(
  setHueStartConfig: (config: HueStartConfig | null) => void,
): void {
  useEffect(() => {
    // Unsubscribing cannot cancel a load already in flight, so the flag is what
    // stops a late read writing into an unmounted tree.
    let cancelled = false;

    const unsubscribe = hueCredentialEvents.subscribe(() => {
      void shellStore
        .load()
        .then((state) => {
          if (cancelled) return;
          setHueStartConfig(toHueStartConfig(state));
        })
        .catch((error) => {
          console.error("[LumaSync] Hue start-config re-projection failed:", error);
        });
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [setHueStartConfig]);
}
