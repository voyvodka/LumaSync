import { useEffect, useState } from "react";

import type { LatencyResult } from "@/shared/contracts/preview";

import { listenLatency } from "../previewEventsApi";

/** The latency scene's newest result while `measuring`; a fresh run starts empty. */
export function useLatencyResult(measuring: boolean): LatencyResult | null {
  const [result, setResult] = useState<LatencyResult | null>(null);

  useEffect(() => {
    setResult(null);
    if (!measuring) return;
    let alive = true;
    let unlisten: (() => void) | null = null;
    void listenLatency((next) => {
      if (alive) setResult(next);
    })
      .then((fn) => {
        if (alive) unlisten = fn;
        else fn();
      })
      .catch((error: unknown) => {
        console.error("[LumaSync] latency listener failed:", error);
      });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [measuring]);

  return result;
}
