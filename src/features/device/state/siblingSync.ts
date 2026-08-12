import { DEVICE_STATUS } from "@/shared/contracts/device";
import type { ConnectionEventBus } from "../connectionEvents";
import type { ConnectionStore } from "./connectionStore";
import { nextStatusForReadyState, toConnectionCard } from "./connectionStateHelpers";
import type { DeviceConnectionControllerDeps } from "./connectionTypes";

export interface SiblingSync {
  hydrateFromRustStatus(): Promise<void>;
  subscribeToSiblings(): void;
  unsubscribe(): void;
}

export function createSiblingSync(
  store: ConnectionStore,
  deps: DeviceConnectionControllerDeps,
  connectionEventsBus: ConnectionEventBus | null,
): SiblingSync {
  let unsubscribeFromEvents: (() => void) | null = null;

  /**
   * Bug 10B helper — pull the latest connection status from Rust and fold it
   * into local state without performing any Rust-side mutation. Used both at
   * the tail end of `initialize()` (warm-boot hydration) and as the listener
   * body for sibling-emitted connection events. Failures are logged but
   * never throw — connection-state hydration is best effort.
   */
  const hydrateFromRustStatus = async () => {
    if (store.isDisposed()) return;
    try {
      const status = await deps.getSerialConnectionStatus();
      if (store.isDisposed()) return;

      if (status.connected && status.portName) {
        const connectedPortName = status.portName;
        store.setState((prev) => ({
          ...prev,
          status: DEVICE_STATUS.CONNECTED,
          connectedPort: connectedPortName,
          selectedPort: prev.selectedPort ?? connectedPortName,
          statusCard: toConnectionCard(status),
          lastSuccessfulPort: connectedPortName,
        }));
      } else if (store.getState().connectedPort !== null) {
        // Sibling emitted "disconnected" (or Rust dropped the session). Mirror
        // that by clearing our connected port. Avoids a stale "ON" badge in
        // LIGHTS after the user unpaired from DEVICES.
        store.setState((prev) => ({
          ...prev,
          status: nextStatusForReadyState(prev.ports),
          connectedPort: null,
          statusCard: toConnectionCard(status),
        }));
      }
    } catch (err) {
      console.error("[LumaSync] getSerialConnectionStatus hydration failed:", err);
    }
  };

  const subscribeToSiblings = () => {
    // Bug 10B — subscribe to sibling controllers' connection events. The
    // emit happens in the controller that *did* the pair (typically the
    // DEVICES section). Other live controllers (App-level, drives the
    // Lights/StatusBar surface) re-pull Rust status so their UI mirrors
    // the real session state without waiting for a WebView reload.
    if (connectionEventsBus && !unsubscribeFromEvents) {
      unsubscribeFromEvents = connectionEventsBus.subscribe(() => {
        // Defer to the microtask queue so the emitting controller's own
        // `setState` has fully flushed before we re-poll. Without this
        // a synchronous emit during a React render boundary would race
        // against the setState batch that put the emitter into the
        // CONNECTED state.
        void hydrateFromRustStatus();
      });
    }
  };

  const unsubscribe = () => {
    if (unsubscribeFromEvents) {
      unsubscribeFromEvents();
      unsubscribeFromEvents = null;
    }
  };

  return { hydrateFromRustStatus, subscribeToSiblings, unsubscribe };
}
