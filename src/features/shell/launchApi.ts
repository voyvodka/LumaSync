import { invoke } from "@tauri-apps/api/core";

import { SHELL_COMMANDS, type LaunchContext } from "@/shared/contracts/shell";

export type LaunchInvoker = <T>(command: string) => Promise<T>;

const defaultInvoke: LaunchInvoker = (command) => invoke(command);

/**
 * Whether autostart launched the app to the tray. A failed read shows the
 * window: an app that silently never appears is worse than one that opens at
 * login.
 */
export async function readStartHidden(invoker: LaunchInvoker = defaultInvoke): Promise<boolean> {
  try {
    const context = await invoker<LaunchContext | undefined>(SHELL_COMMANDS.GET_LAUNCH_CONTEXT);
    return context?.startHidden === true;
  } catch (err) {
    console.warn("[LumaSync] [startup] launch context unavailable; showing the window:", err);
    return false;
  }
}
