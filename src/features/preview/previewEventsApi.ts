/** Subscriptions to the Rust-emitted events the preview surfaces render from. */
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { LIGHTING_MODE_CHANGED_EVENT, type LightingModeChangedPayload } from "@/shared/contracts/mode";
import { EDGE_SIGNAL_EVENT, type EdgeSignalPayload } from "@/features/mode/model/edgeSignal";
import { PREVIEW_STATE_CHANGED_EVENT, type LedPreviewStatus } from "@/shared/contracts/preview";

export type { UnlistenFn };

export function listenEdgeSignal(
  handler: (payload: EdgeSignalPayload) => void,
): Promise<UnlistenFn> {
  return listen<EdgeSignalPayload>(EDGE_SIGNAL_EVENT, (event) => handler(event.payload));
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
