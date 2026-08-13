/** Module-level holder for the boot restore outcome. Retained, not just broadcast: the WLED picker mounts long after the restore settled and still has to explain a failure. */
import type { WledRestoreOutcome } from "./wledSinkRestore";

export type WledRestoreListener = (outcome: WledRestoreOutcome) => void;

export interface WledSinkEventBus {
  publish(outcome: WledRestoreOutcome): void;
  latest(): WledRestoreOutcome;
  subscribe(listener: WledRestoreListener): () => void;
}

export function createWledSinkEventBus(): WledSinkEventBus {
  const listeners = new Set<WledRestoreListener>();
  let current: WledRestoreOutcome = { kind: "idle" };

  return {
    publish(outcome) {
      current = outcome;
      // Snapshot so a listener unsubscribing mid-fanout cannot skip a sibling.
      for (const listener of Array.from(listeners)) {
        try {
          listener(outcome);
        } catch (err) {
          console.error("[LumaSync] wledSinkEvents listener threw:", err);
        }
      }
    },
    latest() {
      return current;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** Process-wide bus, mirroring `connectionEvents`. */
export const wledSinkEvents: WledSinkEventBus = createWledSinkEventBus();
