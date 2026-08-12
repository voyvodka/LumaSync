import { DEVICE_STATUS } from "@/shared/contracts/device";
import type { ConnectionEventBus } from "../connectionEvents";
import type { ConnectionStore } from "./connectionStore";
import type { DeviceConnectionControllerDeps, DeviceStatusCard } from "./connectionTypes";

export async function persistSuccessfulPort(
  deps: DeviceConnectionControllerDeps,
  portName: string,
): Promise<void> {
  try {
    await deps.persistLastSuccessfulPort(portName);
  } catch (err) {
    // Persistence failures should not break an active connection, but we
    // still log so the silent-catch ban is honoured (project CLAUDE.md).
    console.error("[LumaSync] persistLastSuccessfulPort failed:", err);
  }
}

// Shared success-arm for manual connect, auto-recovery, and boot-time
// auto-reconnect — only `statusCard` differs between the three callers.
export async function applySuccessfulConnection(
  store: ConnectionStore,
  deps: DeviceConnectionControllerDeps,
  connectionEventsBus: ConnectionEventBus | null,
  params: { connectedPortName: string; statusCard: DeviceStatusCard },
): Promise<void> {
  const { connectedPortName, statusCard } = params;

  store.setState((prev) => ({
    ...prev,
    status: DEVICE_STATUS.CONNECTED,
    connectedPort: connectedPortName,
    selectedPort: connectedPortName,
    lastSuccessfulPort: connectedPortName,
    statusCard,
  }));

  await persistSuccessfulPort(deps, connectedPortName);

  if (connectionEventsBus) {
    connectionEventsBus.emit({ portName: connectedPortName, connected: true });
  }
}
