// Broadcasts the last completed health check's advertised firmware profile.
// Separate from connectionEvents.ts, whose every emit drives a re-poll a
// health check has no reason to trigger.
import type { FirmwareProfile } from "@/shared/contracts/device";

export interface FirmwareProfileEvent {
  // Mirrors HealthCheckResult.advertisedFirmwareProfile's absence semantics verbatim.
  readonly advertisedFirmwareProfile: FirmwareProfile | undefined;
}

export type FirmwareProfileEventListener = (event: FirmwareProfileEvent) => void;

export interface FirmwareProfileEventBus {
  emit(event: FirmwareProfileEvent): void;
  subscribe(listener: FirmwareProfileEventListener): () => void;
}

export function createFirmwareProfileEventBus(): FirmwareProfileEventBus {
  const listeners = new Set<FirmwareProfileEventListener>();

  return {
    emit(event) {
      const snapshot = Array.from(listeners);
      for (const listener of snapshot) {
        try {
          listener(event);
        } catch (err) {
          console.error("[LumaSync] firmwareProfileEvents listener threw:", err);
        }
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** Default process-wide bus — same lifetime contract as `connectionEvents`. */
export const firmwareProfileEvents: FirmwareProfileEventBus = createFirmwareProfileEventBus();
