/** Bridge to the Tauri window that hosts the calling webview — the main window,
 * or the LED control popup when called from there. */
import type { UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

export type { UnlistenFn };

export function focusCurrentWindow(): Promise<void> {
  return getCurrentWindow().setFocus();
}

export function minimizeCurrentWindow(): Promise<void> {
  return getCurrentWindow().minimize();
}

export function toggleMaximizeCurrentWindow(): Promise<void> {
  return getCurrentWindow().toggleMaximize();
}

export function closeCurrentWindow(): Promise<void> {
  return getCurrentWindow().close();
}

export function isCurrentWindowMaximized(): Promise<boolean> {
  return getCurrentWindow().isMaximized();
}

export function onCurrentWindowResized(handler: () => void): Promise<UnlistenFn> {
  return getCurrentWindow().onResized(handler);
}

export function onCurrentWindowMoved(handler: () => void): Promise<UnlistenFn> {
  return getCurrentWindow().onMoved(handler);
}

/** Centre of the current window in logical px, unrounded. */
export async function readCurrentWindowLogicalCenter(): Promise<{ x: number; y: number }> {
  const win = getCurrentWindow();
  const scale = await win.scaleFactor();
  const pos = await win.outerPosition();
  const size = await win.innerSize();
  return {
    x: (pos.x + size.width / 2) / scale,
    y: (pos.y + size.height / 2) / scale,
  };
}
