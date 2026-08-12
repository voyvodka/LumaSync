import { DEVICE_STATUS, SERIAL_PORT_LIST_STATUS } from "@/shared/contracts/device";
import { resolveInitialSelection, resolveSelectionAfterRefresh } from "../portSelection";
import type { ConnectionStore } from "./connectionStore";
import { nextStatusForReadyState, toDevicePort } from "./connectionStateHelpers";
import type { DeviceConnectionControllerDeps } from "./connectionTypes";
import type { DevicePort } from "../types";

export interface PortDiscovery {
  runInitialScan(): Promise<void>;
  refreshPorts(): Promise<void>;
}

// The port list from `listSerialPorts()` is already VID/PID-allowlisted and
// macOS `cu.*`/`tty.*` deduplicated by Rust — never re-filter or branch on
// raw `vid`/`pid` here.

export function createPortDiscovery(
  store: ConnectionStore,
  deps: DeviceConnectionControllerDeps,
  timing: { refreshMinIntervalMs: number; refreshVisibleWaitMs: number; now: () => number },
  callbacks: { onConnectedPortMissing: (lastSuccessfulPort: string) => void },
): PortDiscovery {
  let initialized = false;
  let refreshToken = 0;
  let lastRefreshAt = 0;

  const applyPortRefresh = (
    ports: DevicePort[],
    isInitialScan: boolean,
  ): { selectedPort: string | null; missingSelection: boolean } => {
    const state = store.getState();
    if (isInitialScan) {
      return {
        selectedPort: resolveInitialSelection(ports, state.lastSuccessfulPort),
        missingSelection: false,
      };
    }

    return resolveSelectionAfterRefresh(ports, state.selectedPort, state.lastSuccessfulPort);
  };

  const runRefresh = async (isInitialScan: boolean) => {
    const currentToken = ++refreshToken;

    store.setState((prev) => ({
      ...prev,
      status:
        prev.isReconnecting || prev.isHealthChecking
          ? prev.status
          : DEVICE_STATUS.SCANNING,
      isScanning: true,
      statusCard: isInitialScan ? null : prev.statusCard,
    }));

    try {
      const minWait = isInitialScan
        ? Promise.resolve()
        : new Promise<void>((resolve) => setTimeout(resolve, timing.refreshVisibleWaitMs));

      const [response] = await Promise.all([deps.listSerialPorts(), minWait]);
      if (currentToken !== refreshToken) {
        return;
      }

      const mappedPorts = response.ports.map(toDevicePort);
      const selectionResult = applyPortRefresh(mappedPorts, isInitialScan);
      const stateBeforeUpdate = store.getState();
      const connectedPortMissing =
        stateBeforeUpdate.connectedPort !== null &&
        !mappedPorts.some((port) => port.portName === stateBeforeUpdate.connectedPort);

      store.setState((prev) => ({
        ...prev,
        status: prev.isReconnecting ? DEVICE_STATUS.RECONNECTING : nextStatusForReadyState(mappedPorts),
        ports: mappedPorts,
        selectedPort: selectionResult.selectedPort,
        connectedPort: connectedPortMissing ? null : prev.connectedPort,
        isScanning: false,
        statusCard: selectionResult.missingSelection
          ? {
              variant: "info",
              code: "SELECTED_PORT_MISSING",
              message: "Previously selected port is no longer available.",
              details: "Pick another port and try Connect again.",
            }
          : prev.statusCard,
      }));

      const lastSuccessfulPort = store.getState().lastSuccessfulPort;
      if (connectedPortMissing && lastSuccessfulPort) {
        callbacks.onConnectedPortMissing(lastSuccessfulPort);
      }

      initialized = true;
      lastRefreshAt = timing.now();
    } catch (error) {
      if (currentToken !== refreshToken) {
        return;
      }

      store.setState((prev) => ({
        ...prev,
        status: DEVICE_STATUS.ERROR,
        isScanning: false,
        statusCard: {
          variant: "error",
          code: SERIAL_PORT_LIST_STATUS.FAILED,
          message: "Could not scan serial ports.",
          details: error instanceof Error ? error.message : String(error),
        },
      }));
    }
  };

  const refreshPorts = async () => {
    if (!initialized) {
      await runRefresh(true);
      return;
    }

    if (timing.now() - lastRefreshAt < timing.refreshMinIntervalMs) {
      store.setState((prev) => ({
        ...prev,
        statusCard: {
          variant: "info",
          code: "REFRESH_RATE_LIMITED",
          message: "Refresh is temporarily limited.",
          details: "Please wait a moment and try again.",
        },
      }));
      return;
    }

    await runRefresh(false);
  };

  return {
    runInitialScan: () => runRefresh(true),
    refreshPorts,
  };
}
