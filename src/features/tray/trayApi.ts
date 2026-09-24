import { SHELL_COMMANDS, type TrayLabels } from "@/shared/contracts/shell";
import { invokeCommand, type CommandInvoker } from "@/shared/ipcApi";

export type { TrayLabels };

/** Push the current locale's tray menu labels to the Rust-owned tray. */
export async function updateTrayLabels(
  labels: TrayLabels,
  invoker: CommandInvoker = invokeCommand,
): Promise<void> {
  await invoker(SHELL_COMMANDS.UPDATE_TRAY_LABELS, { labels });
}
