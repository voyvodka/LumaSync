import { useEffect, useRef } from "react";

import { hueCredentialEvents } from "@/features/hue/hueCredentialEvents";
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
 * the user turned off afterwards, is left as it is. Pairing again is an edge
 * too, and adds back a Hue the user turned off: a bridge whose key was lost
 * stays configured, so re-pairing it crosses no other edge.
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
  const onSelectRef = useRef(onSelectTargets);
  onSelectRef.current = onSelectTargets;

  useEffect(() => {
    if (!ready) return;
    const was = wasConfiguredRef.current;
    wasConfiguredRef.current = hueConfigured;
    if (was !== false || !hueConfigured) return;
    addHue(selectedRef.current, onSelectRef.current);
  }, [ready, hueConfigured]);

  useEffect(
    () =>
      hueCredentialEvents.subscribe(({ reason }) => {
        // A first pairing has no area yet; the edge above adds Hue once one is chosen.
        if (reason !== "paired" || wasConfiguredRef.current !== true) return;
        addHue(selectedRef.current, onSelectRef.current);
      }),
    [],
  );
}

function addHue(
  selected: HueRuntimeTarget[],
  onSelectTargets: HueTargetAutoAddInput["onSelectTargets"],
): void {
  if (selected.includes("hue")) return;
  void onSelectTargets(normalizeOutputTargets([...selected, "hue"])).catch((err) => {
    console.error("[LumaSync] Adding Hue to the outputs after setup failed:", err);
  });
}
