/** Two hooks over one restore: `useWledSinkRestore` runs it once at boot from App.tsx, `useActiveWledSink` is the read-only view the WLED picker mounts later. */
import { useCallback, useEffect, useState } from "react";

import {
  WLED_DEFAULT_DDP_PORT,
  type WledDeviceInfo,
  type WledUdpSinkConfig,
} from "@/shared/contracts/device";
import type { ShellState } from "@/shared/contracts/shell";
import { shellStore } from "../persistence/shellStore";
import {
  connectWledSink,
  discoverWledDevices,
  getWledSinkStatus,
} from "./wledApi";
import {
  wledSinkEvents as defaultWledSinkEvents,
  type WledSinkEventBus,
} from "./wledSinkEvents";
import { persistWledSink } from "./outputChannelPersistence";
import {
  restoreWledSink,
  type WledRestoreOutcome,
  type WledSinkRestoreDeps,
} from "./wledSinkRestore";

/** Guards StrictMode's double-mount, which would otherwise probe and connect twice. */
let restoreStarted = false;

/** Test seam — resets the module-level once-guard. */
export function resetWledRestoreGuard(): void {
  restoreStarted = false;
}

export interface UseWledSinkRestoreDeps
  extends Partial<Pick<WledSinkRestoreDeps, "loadShellState" | "saveShellState" | "discover" | "connect">> {
  wledSinkEvents?: WledSinkEventBus;
}

/** Mount exactly once, at boot. The sink must be registered before a lighting mode starts. */
export function useWledSinkRestore(deps: UseWledSinkRestoreDeps = {}): void {
  const bus = deps.wledSinkEvents ?? defaultWledSinkEvents;
  const loadShellState = deps.loadShellState ?? (() => shellStore.load());
  const saveShellState = deps.saveShellState ?? ((partial) => shellStore.save(partial));
  const discover = deps.discover ?? discoverWledDevices;
  const connect = deps.connect ?? connectWledSink;

  useEffect(() => {
    if (restoreStarted) return;
    restoreStarted = true;

    void restoreWledSink({
      loadShellState,
      saveShellState,
      discover,
      connect,
      onOutcome: (outcome) => bus.publish(outcome),
    });
  }, [bus, loadShellState, saveShellState, discover, connect]);
}

export interface ActiveWledSink {
  /** IP Rust actually has bound, or null. Drives the picker's active-card highlight. */
  activeWledIp: string | null;
  /** Persisted restore intent, which survives a failed restore. */
  savedSink: WledUdpSinkConfig | null;
  restoreOutcome: WledRestoreOutcome;
  /** True once both the Rust snapshot and the persisted record have resolved. */
  ready: boolean;
  /** Record a successful manual connect and re-read the Rust snapshot. */
  markConnected: (device: WledDeviceInfo) => Promise<void>;
}

export interface UseActiveWledSinkDeps {
  wledSinkEvents?: WledSinkEventBus;
  getStatus?: typeof getWledSinkStatus;
  loadShellState?: () => Promise<ShellState>;
  saveShellState?: (partial: Partial<ShellState>) => Promise<void>;
}

export function useActiveWledSink(
  deps: UseActiveWledSinkDeps = {},
): ActiveWledSink {
  const bus = deps.wledSinkEvents ?? defaultWledSinkEvents;
  const getStatus = deps.getStatus ?? getWledSinkStatus;
  const loadShellState = deps.loadShellState ?? (() => shellStore.load());
  const saveShellState = deps.saveShellState ?? ((partial) => shellStore.save(partial));

  const [activeWledIp, setActiveWledIp] = useState<string | null>(null);
  const [savedSink, setSavedSink] = useState<WledUdpSinkConfig | null>(null);
  const [ready, setReady] = useState(false);
  const [restoreOutcome, setRestoreOutcome] = useState<WledRestoreOutcome>(() =>
    bus.latest(),
  );

  const refresh = useCallback(async () => {
    try {
      const [status, stored] = await Promise.all([
        getStatus(),
        loadShellState(),
      ]);
      setActiveWledIp(status.sink?.ip ?? null);
      setSavedSink(stored.lastWledSink ?? null);
    } catch (err) {
      console.error("[LumaSync] useActiveWledSink refresh failed:", err);
    } finally {
      setReady(true);
    }
  }, [getStatus, loadShellState]);

  useEffect(() => {
    void refresh();
    const unsubscribe = bus.subscribe((outcome) => {
      setRestoreOutcome(outcome);
      void refresh();
    });
    return unsubscribe;
  }, [bus, refresh]);

  const markConnected = useCallback(
    async (device: WledDeviceInfo) => {
      try {
        const stored = await loadShellState();
        const previous = stored.lastWledSink;
        // Rust defaults an omitted port/protocol to DDP:4048; the picker has
        // no transport UI yet, so a prior choice is the only other source.
        const sink: WledUdpSinkConfig = {
          ip: device.ip,
          port: previous?.ip === device.ip ? previous.port : WLED_DEFAULT_DDP_PORT,
          ledCount: device.ledCount,
          protocol: previous?.ip === device.ip ? previous.protocol : "ddp",
        };
        await persistWledSink(saveShellState, sink);
        setSavedSink(sink);
      } catch (err) {
        console.error("[LumaSync] persisting the connected WLED sink failed:", err);
      }
      await refresh();
    },
    [loadShellState, saveShellState, refresh],
  );

  return { activeWledIp, savedSink, restoreOutcome, ready, markConnected };
}
