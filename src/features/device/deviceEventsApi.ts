import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { DEVICE_EVENTS, type SerialPortsChangedEvent } from "@/shared/contracts/device";

export type { UnlistenFn };

export function listenSerialPortsChanged(handler: (event: SerialPortsChangedEvent) => void): Promise<UnlistenFn> {
  return listen<SerialPortsChangedEvent>(DEVICE_EVENTS.SERIAL_PORTS_CHANGED, (event) => handler(event.payload));
}
