/**
 * Module-level pub-sub keeping the three `useDeviceConnection` mounts in
 * sync without a WebView reload — see docs/architecture/device-output.md.
 */

/**
 * Bug 10D — boot-time auto-reconnect rejection codes that signal "the
 * persisted USB target is no longer usable", so the App-level subscriber
 * can drop "usb" from `selectedOutputTargets` and avoid the silent
 * `DEVICE_NOT_CONNECTED` mode-change gate. Limited to boot-time auto-
 * reconnect; runtime disconnects flow through the `wasConnected → false`
 * transition in App.tsx and the existing `common:hotplug.usbDisconnected` toast.
 *
 * `PORT_UNSUPPORTED` — Rust rejected the persisted port up-front (e.g.
 *   `/dev/cu.Bluetooth-Incoming-Port` after the WS2812B-only allowlist
 *   tightened in commit 72fba5b).
 * `PORT_NOT_FOUND` — port name no longer enumerates (cable unplugged
 *   before launch).
 */
import { DEVICE_ERROR_CODES } from "@/shared/contracts/device";

/** Boot-time auto-reconnect rejection reasons meaning USB is structurally unusable this session. */
export type ConnectionRejectionCode =
  | typeof DEVICE_ERROR_CODES.PORT_UNSUPPORTED
  | typeof DEVICE_ERROR_CODES.PORT_NOT_FOUND;

/** A USB connect/disconnect transition broadcast to every subscriber. */
export interface ConnectionEvent {
  readonly portName: string;
  readonly connected: boolean;
  /**
   * Optional rejection reason — only populated by the boot-time
   * `tryAutoReconnect` path when `connected === false` AND the rejection
   * means USB is structurally unavailable for this session. Other
   * rejection paths (CONNECT_BUSY, handshake timeout) deliberately do
   * NOT set this so the caller doesn't strip USB on transient failures.
   */
  readonly unsupportedReason?: ConnectionRejectionCode;
}

/** Callback invoked with every emitted `ConnectionEvent`. */
export type ConnectionEventListener = (event: ConnectionEvent) => void;

/** Fan-out channel for connection events; `subscribe` returns its own unsubscribe. */
export interface ConnectionEventBus {
  emit(event: ConnectionEvent): void;
  subscribe(listener: ConnectionEventListener): () => void;
}

/** Creates an isolated `ConnectionEventBus`; use `connectionEvents` for the shared instance. */
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
