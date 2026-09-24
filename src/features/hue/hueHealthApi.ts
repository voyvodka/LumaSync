import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import {
  HUE_HEALTH_CHANGED_EVENT,
  HUE_HEALTH_COMMANDS,
  type HueHealthSnapshot,
  type HueHealthWatch,
} from "@/shared/contracts/hueHealth";

/** The snapshot after a local runtime read; never touches the bridge. */
export async function getHueHealth(): Promise<HueHealthSnapshot> {
  return invoke<HueHealthSnapshot>(HUE_HEALTH_COMMANDS.GET_HUE_HEALTH);
}

/** Tell the monitor what this window needs; answers with the snapshot. */
export async function watchHueHealth(watch: HueHealthWatch): Promise<HueHealthSnapshot> {
  return invoke<HueHealthSnapshot>(HUE_HEALTH_COMMANDS.WATCH_HUE_HEALTH, { watch });
}

/** The manual "check again": re-arms whatever gave up. */
export async function retryHueHealth(): Promise<HueHealthSnapshot> {
  return invoke<HueHealthSnapshot>(HUE_HEALTH_COMMANDS.RETRY_HUE_HEALTH);
}

/** Every published snapshot. Ordering is the store's job: Rust emits after
 * releasing the lock that numbers them, so two can arrive out of order. */
export function listenHueHealth(onSnapshot: (snapshot: HueHealthSnapshot) => void): Promise<UnlistenFn> {
  return listen<HueHealthSnapshot>(HUE_HEALTH_CHANGED_EVENT, (event) => onSnapshot(event.payload));
}
