import { useEffect, useLayoutEffect } from "react";

import { followPreference, getPreference, setPreference } from "@/features/persistence/preferences";
import { resolveKeybindPlatform, UI_ZOOM_STEPS, type UiZoom } from "@/shared/contracts/shell";
import { zoomActionFor, type ZoomAction } from "./zoomKeybinds";

export function stepUiZoom(current: UiZoom, action: ZoomAction): UiZoom {
  if (action === "reset") return 100;
  const index = UI_ZOOM_STEPS.indexOf(current);
  const next = index + (action === "in" ? 1 : -1);
  return UI_ZOOM_STEPS[Math.min(Math.max(next, 0), UI_ZOOM_STEPS.length - 1)] ?? current;
}

/** The title bar stays at 100 %: the webview zoom grows it, the macOS window buttons it lines up
 *  with are native and do not grow. `--lm-chrome-scale` undoes the zoom for it and its height. */
export function applyChromeScale(zoom: UiZoom): void {
  document.documentElement.style.setProperty("--lm-chrome-scale", String(100 / zoom));
}

/**
 * Settings → Interface size in the main window: hands a new size to `onZoom` (the mode hook's
 * sequential transition, which zooms the webview and refits the frame), and ⌘/Ctrl + − 0.
 */
export function useUiZoom({
  disabled = false,
  onZoom,
}: {
  disabled?: boolean;
  onZoom: (zoom: UiZoom) => void;
}): void {
  // Before the first paint: the boot read has hydrated the size, and the bar must not draw once zoomed.
  useLayoutEffect(() => {
    applyChromeScale(getPreference("uiZoom"));
    return followPreference("uiZoom", onZoom);
  }, [onZoom]);

  useEffect(() => {
    if (disabled) return undefined;
    const platform = resolveKeybindPlatform();
    const onKeyDown = (event: KeyboardEvent) => {
      // The room map claims ⌘0 for "fit to view" while it has focus.
      if (event.defaultPrevented) return;
      const action = zoomActionFor(event, platform);
      if (!action) return;
      event.preventDefault();
      const current = getPreference("uiZoom");
      const next = stepUiZoom(current, action);
      if (next !== current) void setPreference("uiZoom", next);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [disabled]);
}
