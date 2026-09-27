import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { DEVICE_EVENTS, type LocalOutputsSnapshot, type SerialPortsChangedEvent } from "@/shared/contracts/device";

export type { UnlistenFn };

export function listenSerialPortsChanged(handler: (event: SerialPortsChangedEvent) => void): Promise<UnlistenFn> {
  return listen<SerialPortsChangedEvent>(DEVICE_EVENTS.SERIAL_PORTS_CHANGED, (event) => handler(event.payload));
}

export function listenLocalOutputsChanged(handler: (snapshot: LocalOutputsSnapshot) => void): Promise<UnlistenFn> {
  return listen<LocalOutputsSnapshot>(DEVICE_EVENTS.LOCAL_OUTPUTS_CHANGED, (event) => handler(event.payload));
}
