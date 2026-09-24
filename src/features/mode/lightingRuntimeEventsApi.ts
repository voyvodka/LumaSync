import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import {
  LIGHTING_RUNTIME_CHANGED_EVENT,
  type LightingRuntimeSnapshot,
} from "@/shared/contracts/lightingRuntime";

/**
 * Every published runtime snapshot, newest first. Rust emits after releasing
 * the lock that numbers them, so two publishers can deliver out of order; a
 * snapshot older than the last one delivered is dropped here.
 */
export function listenLightingRuntime(
  onSnapshot: (snapshot: LightingRuntimeSnapshot) => void,
): Promise<UnlistenFn> {
  let newest = -1;
  return listen<LightingRuntimeSnapshot>(LIGHTING_RUNTIME_CHANGED_EVENT, (event) => {
    if (event.payload.revision <= newest) return;
    newest = event.payload.revision;
    onSnapshot(event.payload);
  });
}
