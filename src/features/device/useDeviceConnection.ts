import { useCallback, useEffect, useRef, useState } from "react";
import type { LedChipType, SerialConnectionStatus } from "@/shared/contracts/device";
import { shellStore } from "../persistence/shellStore";
import { listenSerialPortsChanged } from "./deviceEventsApi";
import { persistSerialPort } from "./outputChannelPersistence";
import {
  connectSerialPort,
  listSerialPorts,
  runSerialHealthCheck,
} from "./deviceConnectionApi";
import { connectionEvents as defaultConnectionEvents } from "./connectionEvents";
import { firmwareProfileEvents as defaultFirmwareProfileEvents } from "./firmwareProfileEvents";
import { createDeviceConnectionController } from "./state/deviceConnectionController";
import { localOutputs } from "./state/localOutputsStore";
import { releaseOthersInApp } from "./state/releaseOthers";
import { DEFAULT_STATE } from "./state/connectionStateHelpers";
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
  /**
   * This mount owns the saved strip's reconnects: once at launch, and when the serial watcher sees it
   * plugged back in. One mount only (App) — two reconnecting at once race for the port.
   */
  ownsReconnects?: boolean;
}

// Two mounts asking for one port at once share the attempt: a second open of a port the first is
// opening fails on the OS lock, and Rust would record that failure against a strip that is fine.
const connecting = new Map<string, Promise<SerialConnectionStatus>>();

function connectOnce(portName: string, chipType: LedChipType | undefined): Promise<SerialConnectionStatus> {
  const running = connecting.get(portName);
  if (running !== undefined) return running;
  const attempt = connectSerialPort(portName, chipType).finally(() => connecting.delete(portName));
  connecting.set(portName, attempt);
  return attempt;
}

export function useDeviceConnection({ ownsReconnects = false }: UseDeviceConnectionOptions = {}): UseDeviceConnectionResult {
  // `null` until the store answers. The controller waits for it: built before, it was torn down and
  // built again once the port arrived, and every mount scanned the ports and read the registry twice.
  const [initialStore, setInitialStore] = useState<{ lastSuccessfulPort: string | undefined } | null>(null);
  const initialLastSuccessfulPort = initialStore?.lastSuccessfulPort;

  useEffect(() => {
    let cancelled = false;

    const loadInitialStoreState = async () => {
      try {
        const stored = await shellStore.load();
        if (!cancelled) {
          setInitialStore({ lastSuccessfulPort: savedSerialPort(stored) });
        }
      } catch (err) {
        // Persistence load failure shouldn't block the controller from
        // initialising; we just lose the auto-reconnect hint for this
        // session. Silent-catch ban: log the error explicitly.
        console.error("[LumaSync] shellStore.load() in useDeviceConnection failed:", err);
        if (!cancelled) {
          setInitialStore({ lastSuccessfulPort: undefined });
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
  const [state, setState] = useState<DeviceConnectionControllerState>(() => ({
    ...DEFAULT_STATE,
    lastSuccessfulPort: initialLastSuccessfulPort,
  }));

  useEffect(() => {
    if (initialStore === null) return undefined;
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
        return connectOnce(portName, chipType);
      },
      localOutputs,
      runSerialHealthCheck,
      persistLastSuccessfulPort: async (portName: string) => {
        await persistSerialPort((update) => shellStore.update(update), portName);
      },
      initialLastSuccessfulPort,
      // Bug 10A — the launch brings the saved strip back without a re-pair. One mount does it:
      // the Devices page's used to try the same port at the same moment.
      autoReconnectOnInit: ownsReconnects,
      connectionEvents: defaultConnectionEvents,
      firmwareProfileEvents: defaultFirmwareProfileEvents,
      listenSerialPortsChanged,
      reconnectOnReplug: ownsReconnects,
      releaseOtherOutputs: releaseOthersInApp,
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
  }, [initialStore, initialLastSuccessfulPort, ownsReconnects]);

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
