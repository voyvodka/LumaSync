/** Subscription to the download progress the Rust updater emits. */
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { UPDATER_EVENTS, type UpdateDownloadProgress } from "@/shared/contracts/updater";

export type { UnlistenFn };

export function listenUpdateDownloadProgress(
  handler: (progress: UpdateDownloadProgress) => void,
): Promise<UnlistenFn> {
  return listen<UpdateDownloadProgress>(UPDATER_EVENTS.DOWNLOAD_PROGRESS, (event) => handler(event.payload));
}
