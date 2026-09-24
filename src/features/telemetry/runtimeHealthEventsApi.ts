import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { TELEMETRY_EVENTS, type RuntimeHealth } from "@/shared/contracts/telemetry";

export type { UnlistenFn };

export function listenRuntimeHealth(handler: (health: RuntimeHealth) => void): Promise<UnlistenFn> {
  return listen<RuntimeHealth>(TELEMETRY_EVENTS.HEALTH_CHANGED, (event) => handler(event.payload));
}
