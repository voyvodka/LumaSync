import { useEffect } from "react";

import { followPreference, getPreference, setPreference } from "@/features/persistence/preferences";
import { resolveKeybindPlatform, UI_ZOOM_STEPS, type UiZoom } from "@/shared/contracts/shell";
import { framedUiZoom, resizeToMode } from "./windowAnimator";
import { windowLifecycleSettled } from "./windowLifecycle";
import { loadShellState } from "./windowShellState";
import { zoomActionFor, type ZoomAction } from "./zoomKeybinds";

export function stepUiZoom(current: UiZoom, action: ZoomAction): UiZoom {
  if (action === "reset") return 100;
  const index = UI_ZOOM_STEPS.indexOf(current);
  const next = index + (action === "in" ? 1 : -1);
  return UI_ZOOM_STEPS[Math.min(Math.max(next, 0), UI_ZOOM_STEPS.length - 1)] ?? current;
}

let resizing: Promise<void> = Promise.resolve();

/**
 * Rust zooms the webview when the size is saved; this grows the main window's frame by the same
 * factor so the layout keeps its design viewport. Serialised: a second key press waits for the
 * first resize rather than reading a frame mid-animation.
 */
function refitFrame(zoom: UiZoom): void {
  resizing = resizing.then(async () => {
    await windowLifecycleSettled();
    const target = zoom / 100;
    const from = framedUiZoom();
    // The boot read already sized the frame; hydration arriving after it is not a change.
    if (target === from) return;
    try {
      const { uiMode } = await loadShellState();
      await resizeToMode(uiMode ?? "compact", { zoom: target, fromZoom: from });
    } catch (error) {
      console.error("[LumaSync] resizing the window for the interface size failed:", error);
    }
  });
}

/** The title bar stays at 100 %: the webview zoom grows it, the macOS window buttons it lines up
 *  with are native and do not grow. `--lm-chrome-scale` undoes the zoom for it and its height. */
function applyChromeScale(zoom: UiZoom): void {
  document.documentElement.style.setProperty("--lm-chrome-scale", String(100 / zoom));
}

/** Settings → Interface size in the main window: its frame, and ⌘/Ctrl + − 0. */
export function useUiZoom({ disabled = false }: { disabled?: boolean } = {}): void {
  useEffect(() => {
    applyChromeScale(getPreference("uiZoom"));
    return followPreference("uiZoom", (zoom) => {
      applyChromeScale(zoom);
      refitFrame(zoom);
    });
  }, []);

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
