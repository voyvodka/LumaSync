/** Subscriptions to the Rust-emitted events the preview surfaces render from. */
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { PREVIEW_EVENTS, type TwinLayout } from "@/shared/contracts/preview";

export type { UnlistenFn };

export function listenTwinLayout(handler: (layout: TwinLayout) => void): Promise<UnlistenFn> {
  return listen<TwinLayout>(PREVIEW_EVENTS.TWIN_LAYOUT, (event) => handler(event.payload));
}
