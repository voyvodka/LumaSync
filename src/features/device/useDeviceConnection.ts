import { useCallback, useEffect, useRef, useState } from "react";
import type { LedChipType } from "@/shared/contracts/device";
import { shellStore } from "../persistence/shellStore";
import { listenSerialPortsChanged } from "./deviceEventsApi";
import { persistSerialPort } from "./outputChannelPersistence";
import {
  connectSerialPort,
  getSerialConnectionStatus,
  listSerialPorts,
  runSerialHealthCheck,
} from "./deviceConnectionApi";
import { connectionEvents as defaultConnectionEvents } from "./connectionEvents";
import { firmwareProfileEvents as defaultFirmwareProfileEvents } from "./firmwareProfileEvents";
import { createDeviceConnectionController } from "./state/deviceConnectionController";
import { DEFAULT_STATE, withDerivedFlags } from "./state/connectionStateHelpers";
import type { DeviceConnectionController, DeviceConnectionControllerState } from "./state/connectionTypes";
import { primaryStripOf, savedSerialPort } from "@/features/strips/model/stripSelectors";

export interface UseDeviceConnectionResult extends DeviceConnectionControllerState {
  isConnected: boolean;
  refreshPorts: () => Promise<void>;
  selectPort: (portName: string | null) => void;
  connectSelectedPort: () => Promise<boolean>;
  runHealthCheck: () => Promise<void>;
}

export interface UseDeviceConnectionOptions {
  /** Reconnect the saved strip when the serial watcher sees it plugged back in. One mount only. */
  reconnectOnReplug?: boolean;
}

export function useDeviceConnection({ reconnectOnReplug = false }: UseDeviceConnectionOptions = {}): UseDeviceConnectionResult {
  const [initialLastSuccessfulPort, setInitialLastSuccessfulPort] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;

    const loadInitialStoreState = async () => {
      try {
        const stored = await shellStore.load();
        if (!cancelled) {
          setInitialLastSuccessfulPort(savedSerialPort(stored));
        }
      } catch (err) {
        // Persistence load failure shouldn't block the controller from
        // initialising; we just lose the auto-reconnect hint for this
        // session. Silent-catch ban: log the error explicitly.
        console.error("[LumaSync] shellStore.load() in useDeviceConnection failed:", err);
        if (!cancelled) {
          setInitialLastSuccessfulPort(undefined);
        }
      }
    };

    void loadInitialStoreState();

    return () => {
      cancelled = true;
    };
  }, []);

  // Built inside the effect, never in render: the controller is disposed on
  // unmount for good, and StrictMode's rehearsal unmount used to dispose the
  // only instance a memo held. With no saved port nothing re-created it, so in
  // dev the shell's copy stopped hearing its siblings and read "USB OFF"
  // beside a connected strip.
  const controllerRef = useRef<DeviceConnectionController | null>(null);
  const [state, setState] = useState<DeviceConnectionControllerState>(() =>
    withDerivedFlags({ ...DEFAULT_STATE, lastSuccessfulPort: initialLastSuccessfulPort }),
  );

  useEffect(() => {
    const controller = createDeviceConnectionController({
      listSerialPorts,
      // Wrap connectSerialPort to inject the persisted chip type.
      // shellStore.load() is cheap (cached after first read); reading it here keeps
      // the controller interface stable so existing tests need no changes.
      connectSerialPort: async (portName: string) => {
        let chipType: LedChipType | undefined;
        try {
          const stored = await shellStore.load();
          chipType = primaryStripOf(stored)?.hardware.chipType;
        } catch (err) {
          console.error(
            "[LumaSync] shellStore.load() during connectSerialPort failed:",
            err,
          );
          chipType = undefined;
        }
        return connectSerialPort(portName, chipType);
      },
      getSerialConnectionStatus,
      runSerialHealthCheck,
      persistLastSuccessfulPort: async (portName: string) => {
        await persistSerialPort((update) => shellStore.update(update), portName);
      },
      initialLastSuccessfulPort,
      // Bug 10A — opt the live React hook into auto-reconnect so the user
      // doesn't have to re-pair on every launch. Tests building their own
      // controller stay opt-out by default to keep their fixtures terse.
      autoReconnectOnInit: true,
      // Bug 10B — share the process-wide event bus so sibling
      // useDeviceConnection() instances (App / DEVICES) stay in sync.
      connectionEvents: defaultConnectionEvents,
      firmwareProfileEvents: defaultFirmwareProfileEvents,
      listenSerialPortsChanged,
      reconnectOnReplug,
      readSavedSerialPort: async () => savedSerialPort(await shellStore.load()),
    });
    controllerRef.current = controller;
    setState(controller.getState());
    const unsubscribe = controller.subscribe((next) => {
      setState(next);
    });

    void controller.initialize();

    return () => {
      unsubscribe();
      controller.dispose();
      if (controllerRef.current === controller) controllerRef.current = null;
    };
  }, [initialLastSuccessfulPort, reconnectOnReplug]);

  const refreshPorts = useCallback(async () => {
    await controllerRef.current?.refreshPorts();
  }, []);
  const selectPort = useCallback((portName: string | null) => {
    controllerRef.current?.selectPort(portName);
  }, []);
  const connectSelectedPort = useCallback(
    async () => (await controllerRef.current?.connectSelectedPort()) ?? false,
    [],
  );
  const runHealthCheck = useCallback(async () => {
    await controllerRef.current?.runHealthCheck();
  }, []);

  return {
    ...state,
    isConnected: Boolean(state.connectedPort),
    refreshPorts,
    selectPort,
    connectSelectedPort,
    runHealthCheck,
  };
}
