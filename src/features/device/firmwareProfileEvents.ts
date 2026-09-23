// Broadcasts what the firmware last said about itself — on a connect's PING
// or a health check. Separate from connectionEvents.ts, whose every emit
// drives a re-poll neither has any reason to trigger.
import type { FirmwarePixelLayout, FirmwareProfile } from "@/shared/contracts/device";

export interface FirmwareProfileEvent {
  // Mirrors HealthCheckResult.advertisedFirmwareProfile's absence semantics verbatim.
  readonly advertisedFirmwareProfile: FirmwareProfile | undefined;
  // Same absence rule: undefined is unknown firmware, never "RGB".
  readonly advertisedPixelLayout: FirmwarePixelLayout | undefined;
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
