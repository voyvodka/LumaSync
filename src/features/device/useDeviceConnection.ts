import { useEffect, useMemo, useState } from "react";
import type { LedChipType } from "@/shared/contracts/device";
import { shellStore } from "../persistence/shellStore";
import {
  connectSerialPort,
  getSerialConnectionStatus,
  listSerialPorts,
  runSerialHealthCheck,
} from "./deviceConnectionApi";
import { connectionEvents as defaultConnectionEvents } from "./connectionEvents";
import { createDeviceConnectionController } from "./state/deviceConnectionController";
import type { DeviceConnectionControllerState } from "./state/connectionTypes";

export interface UseDeviceConnectionResult extends DeviceConnectionControllerState {
  isConnected: boolean;
  refreshPorts: () => Promise<void>;
  selectPort: (portName: string | null) => void;
  connectSelectedPort: () => Promise<void>;
  runHealthCheck: () => Promise<void>;
}

export function useDeviceConnection(): UseDeviceConnectionResult {
  const [initialLastSuccessfulPort, setInitialLastSuccessfulPort] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;

    const loadInitialStoreState = async () => {
      try {
        const stored = await shellStore.load();
        if (!cancelled) {
          setInitialLastSuccessfulPort(stored.lastSuccessfulPort);
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

  const controller = useMemo(
    () =>
      createDeviceConnectionController({
        listSerialPorts,
        // Wrap connectSerialPort to inject the persisted chip type (v1.5 G3 Wire-A).
        // shellStore.load() is cheap (cached after first read); reading it here keeps
        // the controller interface stable so existing tests need no changes.
        connectSerialPort: async (portName: string) => {
          let chipType: LedChipType | undefined;
          try {
            const stored = await shellStore.load();
            chipType = stored.selectedChipType;
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
          await shellStore.save({ lastSuccessfulPort: portName });
        },
        initialLastSuccessfulPort,
        // Bug 10A — opt the live React hook into auto-reconnect so the user
        // doesn't have to re-pair on every launch. Tests building their own
        // controller stay opt-out by default to keep their fixtures terse.
        autoReconnectOnInit: true,
        // Bug 10B — share the process-wide event bus so sibling
        // useDeviceConnection() instances (App / DEVICES) stay in sync.
        connectionEvents: defaultConnectionEvents,
      }),
    [initialLastSuccessfulPort],
  );

  const [state, setState] = useState<DeviceConnectionControllerState>(controller.getState());

  useEffect(() => {
    const unsubscribe = controller.subscribe((next) => {
      setState(next);
    });

    void controller.initialize();

    return () => {
      unsubscribe();
      controller.dispose();
    };
  }, [controller]);

  return {
    ...state,
    isConnected: Boolean(state.connectedPort),
    refreshPorts: controller.refreshPorts,
    selectPort: controller.selectPort,
    connectSelectedPort: controller.connectSelectedPort,
    runHealthCheck: controller.runHealthCheck,
  };
}
