import { useCallback, useEffect, useRef, useState } from "react";

import type { LightingRuntimeSnapshot } from "@/shared/contracts/lightingRuntime";

import { listenLightingRuntime } from "../lightingRuntimeEventsApi";
import { getLightingRuntime } from "../modeApi";

export interface LightingRuntimeMirror {
  /** What the backend runs, or `null` until the first read lands. */
  snapshot: LightingRuntimeSnapshot | null;
  /**
   * Takes a snapshot a command answered with. The same revision also arrives
   * as an event; whichever lands first wins and the other is dropped.
   */
  adopt: (snapshot: LightingRuntimeSnapshot) => void;
}

/**
 * This window's copy of `LightingRuntimeSnapshot`: seeded by
 * `get_lighting_runtime`, then kept by `lighting://runtime-changed`. Every
 * window holds the same one, so the popup, the main window and the tray agree
 * on what runs without asking each other. A snapshot older than the one held
 * is dropped — publishers can deliver out of order, and the seed can land
 * after the first event.
 */
export function useLightingRuntime(): LightingRuntimeMirror {
  const [snapshot, setSnapshot] = useState<LightingRuntimeSnapshot | null>(null);
  const revisionRef = useRef(-1);

  const adopt = useCallback((next: LightingRuntimeSnapshot) => {
    if (next.revision <= revisionRef.current) return;
    revisionRef.current = next.revision;
    setSnapshot(next);
  }, []);

  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | null = null;

    listenLightingRuntime((next) => {
      if (alive) adopt(next);
    })
      .then((fn) => {
        if (alive) unlisten = fn;
        else fn();
      })
      .catch((error) => {
        console.error("[LumaSync] lighting runtime listen failed:", error);
      });

    // After the listener is requested, so a publish between the two is not lost:
    // the revision check drops whichever of the two is older.
    getLightingRuntime()
      .then((seed) => {
        if (alive) adopt(seed);
      })
      .catch((error) => {
        console.error("[LumaSync] lighting runtime read failed:", error);
      });

    return () => {
      alive = false;
      unlisten?.();
    };
  }, [adopt]);

  return { snapshot, adopt };
}
