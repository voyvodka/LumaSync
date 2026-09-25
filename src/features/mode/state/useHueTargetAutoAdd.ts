import { useEffect, useRef } from "react";

import type { HueRuntimeTarget } from "@/shared/contracts/hue";
import { normalizeOutputTargets } from "@/shared/contracts/mode";

export interface HueTargetAutoAddInput {
  /** The launch restore has answered, so `selectedOutputTargets` is the saved selection. */
  ready: boolean;
  /** A bridge is paired and an entertainment area chosen. */
  hueConfigured: boolean;
  selectedOutputTargets: HueRuntimeTarget[];
  /** A saved output choice, as if the user made it. */
  onSelectTargets: (targets: HueRuntimeTarget[]) => Promise<void>;
}

/**
 * Finishing Hue setup is the "I want Hue output" intent, as pairing a strip is
 * for USB (`useUsbTargetReconciler`): a fresh install selects only `usb`, and
 * nothing else added `hue`, so a Hue-only user had no output to run a mode on.
 * Only the edge counts — a setup that was already there at launch, or a Hue
 * the user turned off afterwards, is left as it is.
 */
export function useHueTargetAutoAdd({
  ready,
  hueConfigured,
  selectedOutputTargets,
  onSelectTargets,
}: HueTargetAutoAddInput): void {
  // Null until `ready`: the first value seen then is the launch's, not an edge.
  const wasConfiguredRef = useRef<boolean | null>(null);
  const selectedRef = useRef(selectedOutputTargets);
  selectedRef.current = selectedOutputTargets;

  useEffect(() => {
    if (!ready) return;
    const was = wasConfiguredRef.current;
    wasConfiguredRef.current = hueConfigured;
    if (was !== false || !hueConfigured) return;
    const selected = selectedRef.current;
    if (selected.includes("hue")) return;
    void onSelectTargets(normalizeOutputTargets([...selected, "hue"])).catch((err) => {
      console.error("[LumaSync] Adding Hue to the outputs after setup failed:", err);
    });
  }, [ready, hueConfigured, onSelectTargets]);
}
