/** Subscriptions to the Rust-emitted events the preview surfaces render from. */
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { LIGHTING_MODE_CHANGED_EVENT, type LightingModeChangedPayload } from "@/shared/contracts/mode";
import {
  EDGE_SIGNAL_EVENT,
  PREVIEW_STATE_CHANGED_EVENT,
  type EdgeSignalPayload,
  type LedPreviewStatus,
} from "@/shared/contracts/preview";

export type { UnlistenFn };

// Partial on purpose: the twin ignores a frame without a `leds` buffer rather
// than trusting the wire.
export function listenEdgeSignal(
  handler: (payload: Partial<EdgeSignalPayload>) => void,
): Promise<UnlistenFn> {
  return listen<Partial<EdgeSignalPayload>>(EDGE_SIGNAL_EVENT, (event) => handler(event.payload));
}

export function listenLightingModeChanged(
  handler: (payload: LightingModeChangedPayload) => void,
): Promise<UnlistenFn> {
  return listen<LightingModeChangedPayload>(LIGHTING_MODE_CHANGED_EVENT, (event) =>
    handler(event.payload),
  );
}

export function listenPreviewStateChanged(
  handler: (payload: LedPreviewStatus) => void,
): Promise<UnlistenFn> {
  return listen<LedPreviewStatus>(PREVIEW_STATE_CHANGED_EVENT, (event) => handler(event.payload));
}
