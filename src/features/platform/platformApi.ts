import {
  PLATFORM_COMMANDS,
  type NotificationPayload,
  type NotificationResult,
} from "@/shared/contracts/platform";
import { invokeCommand, type CommandInvoker } from "@/shared/ipcApi";

/** Show a single OS notification toast. */
export async function showNotification(
  payload: NotificationPayload,
  invoker: CommandInvoker = invokeCommand,
): Promise<NotificationResult> {
  return invoker(PLATFORM_COMMANDS.SHOW_NOTIFICATION, { payload });
}

/** Request OS notification permission (no caller yet — closes the contract surface). */
export async function requestNotificationPermission(
  invoker: CommandInvoker = invokeCommand,
): Promise<NotificationResult> {
  return invoker(PLATFORM_COMMANDS.REQUEST_NOTIFICATION_PERMISSION);
}

/** Reveal the LumaSync log directory in the host file browser. */
export async function openLogDir(invoker: CommandInvoker = invokeCommand): Promise<void> {
  await invoker(PLATFORM_COMMANDS.OPEN_LOG_DIR);
}
