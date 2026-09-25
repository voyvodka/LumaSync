/** Subscriptions to the Rust-emitted events the preview surfaces render from. */
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import {
  PREVIEW_EVENTS,
  type EdgeSignalPayload,
  type LedPreviewStatus,
} from "@/shared/contracts/preview";

export type { UnlistenFn };

// Partial on purpose: the twin ignores a frame without a `leds` buffer rather
// than trusting the wire.
export function listenEdgeSignal(
  handler: (payload: Partial<EdgeSignalPayload>) => void,
): Promise<UnlistenFn> {
  return listen<Partial<EdgeSignalPayload>>(PREVIEW_EVENTS.EDGE_SIGNAL, (event) => handler(event.payload));
}

export function listenPreviewStateChanged(
  handler: (payload: LedPreviewStatus) => void,
): Promise<UnlistenFn> {
  return listen<LedPreviewStatus>(PREVIEW_EVENTS.STATE_CHANGED, (event) => handler(event.payload));
}
