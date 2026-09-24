import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { SHELL_EVENTS, type MainWindowVisibility } from "@/shared/contracts/shell";

export type { UnlistenFn };

export function listenMainWindowVisibility(handler: (visibility: MainWindowVisibility) => void): Promise<UnlistenFn> {
  return listen<MainWindowVisibility>(SHELL_EVENTS.MAIN_WINDOW_VISIBILITY, (event) => handler(event.payload));
}
