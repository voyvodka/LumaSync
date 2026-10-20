import type { MouseEvent } from "react";

import { SHELL_COMMANDS } from "@/shared/contracts/shell";
import { invokeCommand, type CommandInvoker } from "@/shared/ipcApi";

export type Platform = "macos" | "windows" | "linux";

export function detectPlatform(): Platform {
  if (typeof navigator === "undefined") return "linux";
  const ua = navigator.userAgent;
  if (/Mac|iPhone|iPod|iPad/i.test(ua)) return "macos";
  if (/Win/i.test(ua)) return "windows";
  return "linux";
}

/** Drag the calling window from where the pointer is: the main window and the control popup. */
export function startWindowDrag(invoker: CommandInvoker = invokeCommand): Promise<null> {
  return invoker(SHELL_COMMANDS.START_WINDOW_DRAG);
}

/**
 * A drag region's `onMouseDown` on macOS. A single press on the region itself, as Tauri's script
 * decides it ("self": the element that carries the bare attribute), is stopped before the script's
 * document listener and dragged through `start_window_drag`: tao's drag anchors on whatever event
 * AppKit saw last, and the window jumped sideways. A double-click passes on to the script for the
 * zoom; elsewhere Tauri's own drag is left alone.
 */
export function handleDragRegionPress(
  event: MouseEvent<HTMLElement>,
  invoker: CommandInvoker = invokeCommand,
): void {
  if (detectPlatform() !== "macos" || event.button !== 0 || event.detail !== 1) return;
  const region = (event.target as HTMLElement).getAttribute?.("data-tauri-drag-region");
  if (region !== "" && region !== "true") return;
  event.preventDefault();
  event.stopPropagation();
  void startWindowDrag(invoker).catch((error) => console.error("[LumaSync] start_window_drag failed:", error));
}
