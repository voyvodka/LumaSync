import type { LightingTuning, RetuneLightingResult } from "@/shared/contracts/lightingRuntime";

export interface RetuneCoalescer {
  /** The newest value of a drag. Sent now, or after the one in flight. */
  push: (tuning: LightingTuning) => void;
  /** A kind change made the last value stale: the next push is sent even if equal. */
  reset: () => void;
}

/** Key-order independent, so two renders building the same payload collapse. */
function signature(tuning: LightingTuning): string {
  return JSON.stringify(tuning, (_key, value: unknown) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
      : value,
  );
}

/**
 * At most one `retune_lighting` in flight and one waiting, the waiting one
 * always the newest. A drag that commits faster than the backend answers
 * sends its first and last values and skips the ones in between; a value
 * equal to the last one sent is not sent at all. This is what keeps a slider
 * drag, or a re-render that rebuilds the same payload, from becoming a storm.
 */
export function createRetuneCoalescer(
  send: (tuning: LightingTuning) => Promise<RetuneLightingResult>,
): RetuneCoalescer {
  let inFlight = false;
  let pending: LightingTuning | null = null;
  let lastSent: string | null = null;

  const start = (tuning: LightingTuning) => {
    inFlight = true;
    lastSent = signature(tuning);
    void send(tuning)
      .catch((error) => {
        console.error("[LumaSync] retune_lighting failed:", error);
      })
      .finally(() => {
        inFlight = false;
        const next = pending;
        pending = null;
        if (next !== null && signature(next) !== lastSent) start(next);
      });
  };

  return {
    push: (tuning) => {
      const sig = signature(tuning);
      if (inFlight) {
        // Back to the value in flight: nothing more needs to go.
        pending = sig === lastSent ? null : tuning;
        return;
      }
      if (sig === lastSent) return;
      start(tuning);
    },
    reset: () => {
      lastSent = null;
      pending = null;
    },
  };
}
