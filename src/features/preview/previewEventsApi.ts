/** Subscriptions to the Rust-emitted events the preview surfaces render from. */
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { PREVIEW_EVENTS, type LatencyResult, type PreviewSession, type TwinLayout } from "@/shared/contracts/preview";

export type { UnlistenFn };

export function listenPreviewSession(handler: (session: PreviewSession) => void): Promise<UnlistenFn> {
  return listen<PreviewSession>(PREVIEW_EVENTS.SESSION, (event) => handler(event.payload));
}

export function listenTwinLayout(handler: (layout: TwinLayout) => void): Promise<UnlistenFn> {
  return listen<TwinLayout>(PREVIEW_EVENTS.TWIN_LAYOUT, (event) => handler(event.payload));
}

export function listenLatency(handler: (result: LatencyResult) => void): Promise<UnlistenFn> {
  return listen<LatencyResult>(PREVIEW_EVENTS.LATENCY, (event) => handler(event.payload));
}
