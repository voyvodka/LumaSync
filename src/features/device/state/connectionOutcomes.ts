import { DEVICE_STATUS } from "@/shared/contracts/device";
import type { ConnectionEventBus } from "../connectionEvents";
import type { ConnectionStore } from "./connectionStore";
import { nextStatusForReadyState } from "./connectionStateHelpers";
import { serialEntry } from "../model/localOutputs";
import type { DeviceConnectionControllerDeps, DeviceStatusCard } from "./connectionTypes";

export async function persistSuccessfulPort(
  deps: DeviceConnectionControllerDeps,
  portName: string,
): Promise<void> {
  try {
    await deps.persistLastSuccessfulPort(portName);
  } catch (err) {
    // Persistence failures should not break an active connection, but we
    // still log so the silent-catch ban is honoured (project AGENTS.md).
    console.error("[LumaSync] persistLastSuccessfulPort failed:", err);
  }
}

// Shared success-arm for manual connect, auto-recovery, and boot-time
// auto-reconnect — only `statusCard` differs between the three callers. The
// connection itself is the registry's: `sync` reads it, and a port Rust does not
// hold connected by then (let go of meanwhile) is not a success. Another strip
// still connected beside it is: the user's switch lets that one go next.
export async function applySuccessfulConnection(
  store: ConnectionStore,
  deps: DeviceConnectionControllerDeps,
  connectionEventsBus: ConnectionEventBus | null,
  sync: () => Promise<void>,
  params: { connectedPortName: string; statusCard: DeviceStatusCard; userInitiated?: boolean },
): Promise<boolean> {
  const { connectedPortName, statusCard, userInitiated } = params;

  await sync();
  if (store.isDisposed()) return false;
  if (!serialEntry(deps.localOutputs.store.get().snapshot, connectedPortName)?.connected) {
    // The operation's status would otherwise stay "connecting": the registry already set the rest.
    store.setState((prev) => ({
      ...prev,
      status: prev.connectedPort !== null ? DEVICE_STATUS.CONNECTED : nextStatusForReadyState(prev.ports),
    }));
    return false;
  }

  store.setState((prev) => ({
    ...prev,
    status: DEVICE_STATUS.CONNECTED,
    selectedPort: connectedPortName,
    lastSuccessfulPort: connectedPortName,
    statusCard,
  }));

  await persistSuccessfulPort(deps, connectedPortName);

  if (connectionEventsBus) {
    connectionEventsBus.emit({
      portName: connectedPortName,
      connected: true,
      ...(userInitiated ? { userInitiated: true } : {}),
    });
  }
  return true;
}
