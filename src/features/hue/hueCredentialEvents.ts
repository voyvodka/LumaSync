// Broadcasts "the persisted Hue pairing or area selection just changed" so the
// App-level `hueStartConfig` mirror can re-project it — third bus of this shape,
// after connectionEvents.ts and firmwareProfileEvents.ts.

/** Carried for the log, not for dispatch: subscribers re-read the store. */
export type HueCredentialChangeReason =
  | "paired"
  | "area-selected"
  | "credentials-migrated";

export interface HueCredentialEvent {
  readonly reason: HueCredentialChangeReason;
}

export type HueCredentialEventListener = (event: HueCredentialEvent) => void;

export interface HueCredentialEventBus {
  emit(event: HueCredentialEvent): void;
  subscribe(listener: HueCredentialEventListener): () => void;
}

export function createHueCredentialEventBus(): HueCredentialEventBus {
  const listeners = new Set<HueCredentialEventListener>();

  return {
    emit(event) {
      // Snapshot so a listener that unsubscribes itself mid-fanout doesn't
      // shift the iterator and skip a sibling.
      const snapshot = Array.from(listeners);
      for (const listener of snapshot) {
        try {
          listener(event);
        } catch (err) {
          console.error("[LumaSync] hueCredentialEvents listener threw:", err);
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
export const hueCredentialEvents: HueCredentialEventBus = createHueCredentialEventBus();
