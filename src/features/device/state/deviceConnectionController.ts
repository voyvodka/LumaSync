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

  const store = createConnectionStore(
    withDerivedFlags({
      ...DEFAULT_STATE,
      lastSuccessfulPort: deps.initialLastSuccessfulPort,
    }),
  );

  const autoRecovery = createAutoRecovery(
    store,
    deps,
    { recoveryFastDelayMs, recoveryRetryDelayMs, recoveryMaxAttempts },
    connectionEventsBus,
  );

  const portDiscovery = createPortDiscovery(
    store,
    deps,
    { refreshMinIntervalMs, refreshVisibleWaitMs, now },
    { onConnectedPortMissing: (lastSuccessfulPort) => autoRecovery.startAutoRecovery(lastSuccessfulPort) },
  );

  const lifecycle = createConnectionLifecycle(store, deps, connectionEventsBus, {
    cancelRecovery: autoRecovery.cancelRecovery,
  });

  const healthCheck = createHealthCheck(store, deps);
  const autoReconnect = createAutoReconnectOnInit(store, deps, connectionEventsBus);
  const siblingSync = createSiblingSync(store, deps, connectionEventsBus);

  const initialize = async () => {
    await portDiscovery.runInitialScan();

    await siblingSync.hydrateFromRustStatus();

    // Bug 10A — if Rust still reports disconnected after hydration AND we
    // have a remembered port, try once to bring the session back. Has to
    // run after the initial scan so the visibility check has a fresh ports
    // list to consult.
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
