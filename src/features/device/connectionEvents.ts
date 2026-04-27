/**
 * Connection Events
 *
 * Module-level pub-sub for serial connection state changes.
 *
 * Why this exists (Bug 10B fix):
 * --------------------------------
 * `useDeviceConnection` is consumed in two places — `App.tsx` (drives the
 * Lights surface, StatusBar pill, and shared `usbConnected` prop) and
 * `DeviceSection.tsx` (the actual pair UI). Each call site builds its own
 * `createDeviceConnectionController` instance, so a successful pair inside
 * the DEVICES section updates *that* controller's `connectedPort`, but the
 * App-level controller never re-polls Rust and the Lights screen still
 * thinks USB is offline until the user reloads the WebView.
 *
 * Rather than collapse both call sites onto a singleton (which would be a
 * disruptive refactor and break the existing test fixtures that build
 * fresh controllers per scenario), we publish a tiny event from the
 * controller that *did* see the successful pair, and every other live
 * controller listens for the broadcast and refreshes its view of Rust
 * state via `getSerialConnectionStatus`.
 *
 * Test seam:
 * ----------
 * Each consumer accepts an optional `connectionEvents` dep. The default
 * export is the process-wide singleton; tests pass an isolated factory
 * (`createConnectionEventBus`) so subscribers from one scenario don't
 * leak into the next.
 */

export interface ConnectionEvent {
  readonly portName: string;
  readonly connected: boolean;
}

export type ConnectionEventListener = (event: ConnectionEvent) => void;

export interface ConnectionEventBus {
  emit(event: ConnectionEvent): void;
  subscribe(listener: ConnectionEventListener): () => void;
}

export function createConnectionEventBus(): ConnectionEventBus {
  const listeners = new Set<ConnectionEventListener>();

  return {
    emit(event) {
      // Snapshot the listener set so a listener that unsubscribes itself
      // mid-fanout doesn't shift the iterator and skip a sibling.
      const snapshot = Array.from(listeners);
      for (const listener of snapshot) {
        try {
          listener(event);
        } catch (err) {
          console.error("[LumaSync] connectionEvents listener threw:", err);
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

/**
 * Default process-wide bus. Browser-tab lifetime — disposed implicitly on
 * window unload. Each `useDeviceConnection` hook instance subscribes on
 * mount and unsubscribes on unmount, so a stale subscriber never lives
 * past its React tree.
 */
export const connectionEvents: ConnectionEventBus = createConnectionEventBus();
