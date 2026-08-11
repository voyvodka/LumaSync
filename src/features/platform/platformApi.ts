import { invoke } from "@tauri-apps/api/core";

import {
  PLATFORM_COMMANDS,
  type NotificationPayload,
  type NotificationResult,
} from "@/shared/contracts/platform";

export type PlatformInvoker = <T>(command: string, payload?: Record<string, unknown>) => Promise<T>;

// Omit the second arg entirely when there is no payload — GlobalErrorBoundary.test.tsx
// asserts a bare `invoke("open_log_dir")` call, and `invoke(cmd, undefined)` is a
// different (failing) mock-call shape even though Tauri treats both the same at runtime.
const defaultInvoke: PlatformInvoker = (command, payload) =>
  payload === undefined ? invoke(command) : invoke(command, payload);

/** Show a single OS notification toast. */
export async function showNotification(
  payload: NotificationPayload,
  invoker: PlatformInvoker = defaultInvoke,
): Promise<NotificationResult> {
  return invoker<NotificationResult>(PLATFORM_COMMANDS.SHOW_NOTIFICATION, { payload });
}

/** Request OS notification permission (no caller yet — closes the contract surface). */
export async function requestNotificationPermission(
  invoker: PlatformInvoker = defaultInvoke,
): Promise<NotificationResult> {
  return invoker<NotificationResult>(PLATFORM_COMMANDS.REQUEST_NOTIFICATION_PERMISSION);
}

/** Reveal the LumaSync log directory in the host file browser. */
export async function openLogDir(invoker: PlatformInvoker = defaultInvoke): Promise<void> {
  return invoker<void>(PLATFORM_COMMANDS.OPEN_LOG_DIR);
}
