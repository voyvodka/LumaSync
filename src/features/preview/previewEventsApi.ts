/** Subscriptions to the Rust-emitted events the preview surfaces render from. */
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { PREVIEW_EVENTS, type EdgeSignalPayload } from "@/shared/contracts/preview";

export type { UnlistenFn };

// Partial on purpose: the twin ignores a frame without a `leds` buffer rather
// than trusting the wire.
export function listenEdgeSignal(
  handler: (payload: Partial<EdgeSignalPayload>) => void,
): Promise<UnlistenFn> {
  return listen<Partial<EdgeSignalPayload>>(PREVIEW_EVENTS.EDGE_SIGNAL, (event) => handler(event.payload));
}
