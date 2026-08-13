import { useEffect, useRef, type RefObject } from "react";

import {
  LIGHTING_MODE_KIND,
  type LightingModeConfig,
  type SolidColorPayload,
} from "@/features/mode/model/contracts";
import type { HueRuntimeTarget } from "@/shared/contracts/hue";

import { readHueStreamStatus } from "../hueReadCache";

export interface HueSolidBootstrapSyncInput {
  activeOutputTargets: HueRuntimeTarget[];
  lightingModeRef: RefObject<LightingModeConfig>;
  /** Invoked only when the bridge has a colour AND the UI is still in SOLID. */
  onAdoptSolid: (solid: SolidColorPayload) => void;
}

/** Reads the bridge's `lastSolidColor` into the UI once per entry into Hue
 *  Running. One direction only — a user edit must never be overwritten. */
export function useHueSolidBootstrapSync({
  activeOutputTargets,
  lightingModeRef,
  onAdoptSolid,
}: HueSolidBootstrapSyncInput): void {
  /** Latches the one read per Running entry; untouched by user colour edits. */
  const hueSolidSyncedRef = useRef(false);
  const prevHueActiveRef = useRef(false);
  // Held in a ref so the effect keeps `[activeOutputTargets]` as its only dep.
  const onAdoptSolidRef = useRef(onAdoptSolid);
  onAdoptSolidRef.current = onAdoptSolid;

  useEffect(() => {
    const hueNowActive = activeOutputTargets.includes("hue");

    if (!hueNowActive && prevHueActiveRef.current) {
      hueSolidSyncedRef.current = false;
    }

    if (hueNowActive && !hueSolidSyncedRef.current) {
      // Latch before the await so a re-render mid-flight cannot fire a second read.
      hueSolidSyncedRef.current = true;
      void readHueStreamStatus()
        .then((result) => {
          const snap = result.lastSolidColor;
          // Only adopt while the UI is still in SOLID. Bugs #43/#44 — an
          // Ambilight session with Hue targets flipped to Solid the moment the
          // stream came up, and then raced the running ambilight worker.
          if (snap && lightingModeRef.current.kind === LIGHTING_MODE_KIND.SOLID) {
            onAdoptSolidRef.current({
              r: snap.r,
              g: snap.g,
              b: snap.b,
              brightness: snap.brightness,
            });
          }
        })
        .catch((error) => {
          console.error("[LumaSync] Bootstrap solid color read failed:", error);
          // Unlatch so the next connection retries.
          hueSolidSyncedRef.current = false;
        });
    }

    prevHueActiveRef.current = hueNowActive;
  }, [activeOutputTargets, lightingModeRef]);
}
