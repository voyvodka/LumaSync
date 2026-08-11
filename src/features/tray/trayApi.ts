import { invoke } from "@tauri-apps/api/core";

import { SHELL_COMMANDS } from "@/shared/contracts/shell";

export interface TrayLabels {
  openSettings: string;
  lightsOff: string;
  resumeLastMode: string;
  solidColor: string;
  /** Optional so the Rust handler keeps its existing default while the label rolls out additively. */
  showLedPreview?: string;
  quit: string;
}

export type TrayInvoker = <T>(command: string, payload?: Record<string, unknown>) => Promise<T>;

const defaultInvoke: TrayInvoker = (command, payload) => invoke(command, payload);

export async function updateTrayLabels(
  labels: TrayLabels,
  invoker: TrayInvoker = defaultInvoke,
): Promise<void> {
  await invoker<void>(SHELL_COMMANDS.UPDATE_TRAY_LABELS, { labels });
}
