/**
 * useUsbConnectionStatus — lightweight read-only snapshot of the
 * currently bound USB serial port.
 *
 * Why this exists (Wave 4-E):
 * ---------------------------
 * The room-map editor needs to render a live "ONLINE / OFFLINE" badge
 * on every `UsbStripObject` and inside `UsbStripInspector`, but
 * mounting the full `useDeviceConnection` hook there would:
 *   1. duplicate the auto-reconnect state machine that already runs
 *      inside `App.tsx` and `DeviceSection.tsx`,
 *   2. spawn an extra `getSerialConnectionStatus` poll loop,
 *   3. drag in scan / connect / health-check actions the editor does
 *      not need.
 *
 * Instead we listen to the existing `connectionEvents` pub/sub bus
 * (Wave 3, commit `ee30ee2`) and seed the initial snapshot from a
 * single `getSerialConnectionStatus` call. Whenever any other
 * controller in the app emits a connection-changed event, this hook
 * re-syncs from Rust so the editor never reads stale data.
 *
 * Test seam:
 * ----------
 * Every dependency is injected — the bus, the snapshot fetcher, and
 * the side-effect logger — so unit tests can drive both the success
 * and failure paths without touching the global Tauri bridge.
 */
import { useEffect, useRef, useState } from "react";

import {
  connectionEvents as defaultConnectionEvents,
  type ConnectionEventBus,
} from "./connectionEvents";
import {
  getSerialConnectionStatus as defaultGetSerialConnectionStatus,
  type SerialConnectionStatus,
} from "./deviceConnectionApi";

export interface UseUsbConnectionStatusDeps {
  /** Inject for tests; defaults to the process-wide singleton bus. */
  connectionEvents?: ConnectionEventBus;
  /** Inject for tests; defaults to the Tauri-backed status fetch. */
  getStatus?: () => Promise<SerialConnectionStatus>;
}

export interface UsbConnectionSnapshot {
  /** Currently connected port name; null when idle / disconnected. */
  connectedPort: string | null;
  /** True once the initial Rust snapshot has resolved. */
  ready: boolean;
}

/**
 * Subscribe to `connectionEvents` and re-fetch the Rust status when
 * any controller emits a change. Returns a stable `UsbConnectionSnapshot`
 * the dock + canvas overlays can consume.
 */
export function useUsbConnectionStatus(
  deps: UseUsbConnectionStatusDeps = {},
): UsbConnectionSnapshot {
  const bus = deps.connectionEvents ?? defaultConnectionEvents;
  const fetchStatus = deps.getStatus ?? defaultGetSerialConnectionStatus;

  const [snapshot, setSnapshot] = useState<UsbConnectionSnapshot>({
    connectedPort: null,
    ready: false,
  });

  // Track the latest in-flight request so a stale resolve cannot
  // overwrite a fresher value (matches the pattern in
  // `useDeviceConnection`).
  const requestSeqRef = useRef(0);

  useEffect(() => {
    let cancelled = false;

    const refresh = async () => {
      const seq = ++requestSeqRef.current;
      try {
        const status = await fetchStatus();
        if (cancelled || seq !== requestSeqRef.current) return;
        setSnapshot({
          connectedPort: status.portName ?? null,
          ready: true,
        });
      } catch (err) {
        // Silent-catch ban — log every IO failure with a contextual
        // prefix so live debugging surfaces the cause without the user
        // ever seeing a half-rendered chip.
        console.error("[LumaSync] useUsbConnectionStatus fetch failed:", err);
        if (cancelled) return;
        setSnapshot((prev) => ({ ...prev, ready: true }));
      }
    };

    void refresh();
    const unsubscribe = bus.subscribe(() => {
      void refresh();
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
    // `bus` and `fetchStatus` are stable references for the lifetime
    // of the consumer; depending on them keeps the hook resilient if a
    // consumer ever swaps deps mid-tree.
  }, [bus, fetchStatus]);

  return snapshot;
}
