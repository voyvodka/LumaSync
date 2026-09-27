/** Two hooks over one restore: `useWledSinkRestore` runs it once at boot from App.tsx, `useActiveWledSink` is the read-only view the WLED picker mounts later. */
import { useCallback, useEffect, useState } from "react";


import {
  WLED_DEFAULT_DDP_PORT,
  WLED_STATUS,
  type DrivenOutputRef,
  type WledCommandStatus,
  type WledDeviceInfo,
  type WledUdpSinkConfig,
} from "@/shared/contracts/device";
import { parseCommandError } from "@/shared/contracts/status";
import type { ShellState } from "@/shared/contracts/shell";
import { shellStore } from "../persistence/shellStore";
import { connectWledSink, discoverWledDevices, forgetWledDevice } from "./wledApi";
import { wledOutput } from "./model/localOutputs";
import { localOutputs as defaultLocalOutputs, type LocalOutputs } from "./state/localOutputsStore";
import { releaseOthersInApp } from "./state/releaseOthers";
import { useStoreSelector } from "@/shared/lib/store";
import {
  wledSinkEvents as defaultWledSinkEvents,
  type WledSinkEventBus,
} from "./wledSinkEvents";
import { persistWledSink, type ShellStateUpdater } from "./outputChannelPersistence";
import {
  restoreWledSink,
  type WledRestoreOutcome,
  type WledSinkRestoreDeps,
} from "./wledSinkRestore";
import { savedWledSink } from "@/features/strips/model/stripSelectors";

/** Guards StrictMode's double-mount, which would otherwise probe and connect twice. */
let restoreStarted = false;

/** Test seam — resets the module-level once-guard. */
export function resetWledRestoreGuard(): void {
  restoreStarted = false;
}

export interface UseWledSinkRestoreDeps
  extends Partial<Pick<WledSinkRestoreDeps, "loadShellState" | "updateShellState" | "discover" | "connect">> {
  wledSinkEvents?: WledSinkEventBus;
}

/** Mount exactly once, at boot. The sink must be registered before a lighting mode starts. */
export function useWledSinkRestore(deps: UseWledSinkRestoreDeps = {}): void {
  const bus = deps.wledSinkEvents ?? defaultWledSinkEvents;
  const loadShellState = deps.loadShellState ?? (() => shellStore.load());
  const updateShellState = deps.updateShellState ?? ((update) => shellStore.update(update));
  const discover = deps.discover ?? discoverWledDevices;
  const connect = deps.connect ?? connectWledSink;

  useEffect(() => {
    if (restoreStarted) return;
    restoreStarted = true;

    void restoreWledSink({
      loadShellState,
      updateShellState,
      discover,
      connect,
      onOutcome: (outcome) => bus.publish(outcome),
    });
  }, [bus, loadShellState, updateShellState, discover, connect]);
}

export interface ActiveWledSink {
  /** IP Rust actually has bound, or null, from the local-output registry. Drives the picker's active-card highlight. */
  activeWledIp: string | null;
  /** Persisted restore intent, which survives a failed restore. */
  savedSink: WledUdpSinkConfig | null;
  restoreOutcome: WledRestoreOutcome;
  /** True once both the registry and the persisted record have resolved. */
  ready: boolean;
  /** Record a successful manual connect and re-read the registry. */
  markConnected: (device: WledDeviceInfo) => Promise<void>;
  /** Stop sending to the device, unbind it and drop it from the saved state.
   *  Never throws; check `code`. */
  forget: (ip: string) => Promise<WledCommandStatus>;
}

export interface UseActiveWledSinkDeps {
  wledSinkEvents?: WledSinkEventBus;
  localOutputs?: LocalOutputs;
  forgetDevice?: typeof forgetWledDevice;
  /** The one-output-at-a-time switch, after the user's own connect. */
  releaseOthers?: (kept: DrivenOutputRef) => Promise<void>;
  loadShellState?: () => Promise<ShellState>;
  updateShellState?: ShellStateUpdater;
}

// Stable across renders: `refresh` depends on them, and a fresh arrow per render
// re-ran its effect on every App render — two IPC reads each time.
const loadShell = () => shellStore.load();
const updateShell: ShellStateUpdater = (update) => shellStore.update(update);

export function useActiveWledSink(
  deps: UseActiveWledSinkDeps = {},
): ActiveWledSink {
  const bus = deps.wledSinkEvents ?? defaultWledSinkEvents;
  const outputs = deps.localOutputs ?? defaultLocalOutputs;
  const forgetDevice = deps.forgetDevice ?? forgetWledDevice;
  const releaseOthers = deps.releaseOthers ?? releaseOthersInApp;
  const loadShellState = deps.loadShellState ?? loadShell;
  const updateShellState = deps.updateShellState ?? updateShell;

  useEffect(() => outputs.start(), [outputs]);
  const activeWledIp = useStoreSelector(outputs.store, (state) => wledOutput(state.snapshot)?.ip ?? null);
  const [savedSink, setSavedSink] = useState<WledUdpSinkConfig | null>(null);
  const [ready, setReady] = useState(false);
  const [restoreOutcome, setRestoreOutcome] = useState<WledRestoreOutcome>(() =>
    bus.latest(),
  );

  const refresh = useCallback(async () => {
    try {
      const [, stored] = await Promise.all([outputs.refresh(), loadShellState()]);
      setSavedSink(savedWledSink(stored) ?? null);
    } catch (err) {
      console.error("[LumaSync] useActiveWledSink refresh failed:", err);
    } finally {
      setReady(true);
    }
  }, [outputs, loadShellState]);

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
        // Rust defaults an omitted port/protocol to DDP:4048; the picker has
        // no transport UI yet, so a prior choice is the only other source.
        const sink = await persistWledSink(updateShellState, (previous) => ({
          ip: device.ip,
          port: previous?.ip === device.ip ? previous.port : WLED_DEFAULT_DDP_PORT,
          ledCount: device.ledCount,
          protocol: previous?.ip === device.ip ? previous.protocol : "ddp",
        }));
        setSavedSink(sink);
      } catch (err) {
        console.error("[LumaSync] persisting the connected WLED sink failed:", err);
      }
      await releaseOthers({ kind: "wled", ip: device.ip });
      await refresh();
    },
    [updateShellState, releaseOthers, refresh],
  );

  const forget = useCallback(
    async (ip: string): Promise<WledCommandStatus> => {
      let status: WledCommandStatus;
      try {
        status = (await forgetDevice(ip)).status;
      } catch (err) {
        console.error("[LumaSync] forgetting the WLED device failed:", err);
        status = {
          code: WLED_STATUS.FORGET_FAILED,
          message: "The WLED device was not forgotten.",
          details: parseCommandError(err).message,
        };
      }
      // The launch's restore note is about the device that just went.
      if (status.code === WLED_STATUS.FORGET_OK) bus.publish({ kind: "no-saved-device" });
      await refresh();
      return status;
    },
    [bus, forgetDevice, refresh],
  );

  return { activeWledIp, savedSink, restoreOutcome, ready, markConnected, forget };
}
