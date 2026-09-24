import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { RUNTIME_HEALTH_CHANGED_EVENT, type RuntimeHealth } from "@/shared/contracts/telemetry";

export type { UnlistenFn };

export function listenRuntimeHealth(handler: (health: RuntimeHealth) => void): Promise<UnlistenFn> {
  return listen<RuntimeHealth>(RUNTIME_HEALTH_CHANGED_EVENT, (event) => handler(event.payload));
}
