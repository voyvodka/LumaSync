/** Subscription to the download progress the Rust updater emits. */
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { UPDATER_PROGRESS_EVENT, type UpdateDownloadProgress } from "@/shared/contracts/updater";

export type { UnlistenFn };

export function listenUpdateDownloadProgress(
  handler: (progress: UpdateDownloadProgress) => void,
): Promise<UnlistenFn> {
  return listen<UpdateDownloadProgress>(UPDATER_PROGRESS_EVENT, (event) => handler(event.payload));
}
