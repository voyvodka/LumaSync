import { SHELL_COMMANDS } from "@/shared/contracts/shell";
import { invokeCommand, type CommandInvoker } from "@/shared/ipcApi";

/** Drag the main window from where the pointer is; main window only. */
export function startWindowDrag(invoker: CommandInvoker = invokeCommand): Promise<null> {
  return invoker(SHELL_COMMANDS.START_WINDOW_DRAG);
}
