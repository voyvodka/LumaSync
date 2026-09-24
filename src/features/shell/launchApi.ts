import { SHELL_COMMANDS, type LaunchContext } from "@/shared/contracts/shell";
import { invokeCommand, type CommandInvoker } from "@/shared/ipcApi";

// Read as `| undefined`: a mocked or older backend answers nothing, and both
// reads must survive it. Each export names the command itself, so
// scripts/verify/window-grants.mjs attributes it to the export that invokes it.

/**
 * Whether autostart launched the app to the tray. A failed read shows the
 * window: an app that silently never appears is worse than one that opens at
 * login.
 */
export async function readStartHidden(invoker: CommandInvoker = invokeCommand): Promise<boolean> {
  try {
    const context: LaunchContext | undefined = await invoker(SHELL_COMMANDS.GET_LAUNCH_CONTEXT);
    return context?.startHidden === true;
  } catch (err) {
    console.warn("[LumaSync] [startup] launch context unavailable; showing the window:", err);
    return false;
  }
}

/**
 * Whether this binary was built for the e2e suite. A failed read answers
 * `false`: the normal startup behaviour is the safe default for a user.
 */
export async function readE2eBuild(invoker: CommandInvoker = invokeCommand): Promise<boolean> {
  try {
    const context: LaunchContext | undefined = await invoker(SHELL_COMMANDS.GET_LAUNCH_CONTEXT);
    return context?.e2eBuild === true;
  } catch (err) {
    console.warn("[LumaSync] [startup] launch context unavailable; assuming a normal build:", err);
    return false;
  }
}

/** Spawns a fresh app process and exits this one. */
export async function relaunchApp(): Promise<void> {
  const { relaunch } = await import("@tauri-apps/plugin-process");
  await relaunch();
}
