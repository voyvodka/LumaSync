import { invoke } from "@tauri-apps/api/core";

import { SHELL_COMMANDS } from "@/shared/contracts/shell";

/** Localized strings for the tray menu items, pushed to Rust on language/mode change. */
export interface TrayLabels {
  openSettings: string;
  lightsOff: string;
  resumeLastMode: string;
  solidColor: string;
  /** Optional so the Rust handler keeps its existing default while the label rolls out additively. */
  showLedPreview?: string;
  quit: string;
}

/** Injectable `invoke()` signature so tray commands can be unit-tested with a mock transport. */
export type TrayInvoker = <T>(command: string, payload?: Record<string, unknown>) => Promise<T>;

const defaultInvoke: TrayInvoker = (command, payload) => invoke(command, payload);

/** Push the current locale's tray menu labels to the Rust-owned tray. */
export async function updateTrayLabels(
  labels: TrayLabels,
  invoker: TrayInvoker = defaultInvoke,
): Promise<void> {
  await invoker<void>(SHELL_COMMANDS.UPDATE_TRAY_LABELS, { labels });
}
