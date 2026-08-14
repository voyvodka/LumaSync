/** `invoke()` bridge for the channel-aware updater commands. Never throws —
 * every response carries a coded `status`. */
import { invoke } from "@tauri-apps/api/core";

import {
  UPDATER_COMMANDS,
  type UpdateCheckResponse,
  type UpdateInstallResponse,
} from "@/shared/contracts/updater";

export async function checkForUpdate(): Promise<UpdateCheckResponse> {
  return invoke<UpdateCheckResponse>(UPDATER_COMMANDS.CHECK_FOR_UPDATE);
}

export async function downloadAndInstallUpdate(): Promise<UpdateInstallResponse> {
  return invoke<UpdateInstallResponse>(UPDATER_COMMANDS.DOWNLOAD_AND_INSTALL_UPDATE);
}
