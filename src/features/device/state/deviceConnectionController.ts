import { DEFAULT_STATE, withDerivedFlags } from "./connectionStateHelpers";
import { createConnectionStore } from "./connectionStore";
import { createPortDiscovery } from "./portDiscovery";
import { createConnectionLifecycle } from "./connectionLifecycle";
import { createHealthCheck } from "./healthCheck";
import { createAutoRecovery } from "./autoRecovery";
import { createAutoReconnectOnInit } from "./autoReconnectOnInit";
import { createSiblingSync } from "./siblingSync";
import type { DeviceConnectionController, DeviceConnectionControllerDeps } from "./connectionTypes";

const REFRESH_MIN_VISIBLE_MS = 600;

export function createDeviceConnectionController(
  deps: DeviceConnectionControllerDeps,
): DeviceConnectionController {
  const now = deps.now ?? (() => Date.now());
  const refreshMinIntervalMs = deps.refreshMinIntervalMs ?? 250;
  const recoveryFastDelayMs = deps.recoveryFastDelayMs ?? 150;
  const recoveryRetryDelayMs = deps.recoveryRetryDelayMs ?? 600;
  const recoveryMaxAttempts = deps.recoveryMaxAttempts ?? 4;
  const refreshVisibleWaitMs = deps.refreshVisibleWaitMs ?? REFRESH_MIN_VISIBLE_MS;
  const autoReconnectOnInit = deps.autoReconnectOnInit ?? false;
  const connectionEventsBus = deps.connectionEvents ?? null;
  const firmwareProfileEventsBus = deps.firmwareProfileEvents ?? null;

  // Connect PINGs the firmware too, so every connect path — manual, the boot
  // auto-reconnect, recovery — tells the pickers what it found, and a silent
  // device clears what an earlier one reported.
  const connectDeps: DeviceConnectionControllerDeps = {
    ...deps,
    connectSerialPort: async (portName) => {
      const status = await deps.connectSerialPort(portName);
      if (status.connected) {
        firmwareProfileEventsBus?.emit({
          advertisedFirmwareProfile: status.firmware?.profile,
          advertisedPixelLayout: status.firmware?.pixelLayout,
        });
      }
      return status;
    },
  };

  const store = createConnectionStore(
    withDerivedFlags({
      ...DEFAULT_STATE,
      lastSuccessfulPort: deps.initialLastSuccessfulPort,
    }),
  );

  const autoRecovery = createAutoRecovery(
    store,
    connectDeps,
    { recoveryFastDelayMs, recoveryRetryDelayMs, recoveryMaxAttempts },
    connectionEventsBus,
  );

  const portDiscovery = createPortDiscovery(
    store,
    deps,
    { refreshMinIntervalMs, refreshVisibleWaitMs, now },
    { onConnectedPortMissing: (lastSuccessfulPort) => autoRecovery.startAutoRecovery(lastSuccessfulPort) },
  );

  const lifecycle = createConnectionLifecycle(store, connectDeps, connectionEventsBus, {
    cancelRecovery: autoRecovery.cancelRecovery,
  });

  const healthCheck = createHealthCheck(store, deps, firmwareProfileEventsBus);
  const autoReconnect = createAutoReconnectOnInit(store, connectDeps, connectionEventsBus);
  const siblingSync = createSiblingSync(store, deps, connectionEventsBus);

  const initialize = async () => {
    await portDiscovery.runInitialScan();

    await siblingSync.hydrateFromRustStatus();

    // Bug 10A — one attempt to bring a remembered port back. Must run after the
    // initial scan, or the visibility check consults a stale ports list.
    const state = store.getState();
    if (
      autoReconnectOnInit &&
      state.connectedPort === null &&
      typeof state.lastSuccessfulPort === "string" &&
      state.lastSuccessfulPort.length > 0
    ) {
      await autoReconnect.tryAutoReconnect(state.lastSuccessfulPort);
    }

    siblingSync.subscribeToSiblings();
  };

  const dispose = () => {
    store.dispose();
    autoRecovery.clearRecoveryTimer();
    siblingSync.unsubscribe();
  };

  return {
    getState: () => store.getState(),
    subscribe: (listener) => store.subscribe(listener),
    initialize,
    refreshPorts: portDiscovery.refreshPorts,
    selectPort: lifecycle.selectPort,
    connectSelectedPort: lifecycle.connectSelectedPort,
    runHealthCheck: healthCheck.runHealthCheck,
    dispose,
  };
}
