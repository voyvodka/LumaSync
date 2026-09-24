import { SHELL_COMMANDS, type MainWindowVisibility } from "@/shared/contracts/shell";
import { invokeCommand, type CommandInvoker } from "@/shared/ipcApi";

/** A live read of the native main window: shown and not minimised. */
export function getMainWindowVisibility(invoker: CommandInvoker = invokeCommand): Promise<MainWindowVisibility> {
  return invoker(SHELL_COMMANDS.GET_MAIN_WINDOW_VISIBILITY);
}
