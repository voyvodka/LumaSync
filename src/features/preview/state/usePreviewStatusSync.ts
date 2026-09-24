/**
 * usePreviewStatusSync — the LED preview runtime as the control popup sees it.
 *
 * The popup is a SEPARATE webview from the main window, so it listens to
 * `preview://state-changed` (test started/stopped, overlay opened/closed,
 * popup shown/hidden), seeded once on mount by `get_led_preview_status` so it
 * renders correctly even when it opened mid-session. What lighting mode runs
 * comes from the runtime snapshot (`useLightingRuntime`), not from here.
 */

import { useEffect, useState } from "react";

import type { LedPreviewStatus } from "@/shared/contracts/preview";
import { getLedPreviewStatus } from "../previewApi";
import { listenPreviewStateChanged, type UnlistenFn } from "../previewEventsApi";

/** Latest preview runtime snapshot, or `null` until the first sync. */
export function usePreviewStatusSync(): LedPreviewStatus | null {
  const [preview, setPreview] = useState<LedPreviewStatus | null>(null);

  useEffect(() => {
    let alive = true;
    let unlisten: UnlistenFn | null = null;

    void getLedPreviewStatus()
      .then((status) => {
        if (alive) setPreview(status);
      })
      .catch((error) => {
        console.error("[LumaSync] usePreviewStatusSync initial read failed:", error);
      });

    listenPreviewStateChanged((payload) => {
      setPreview(payload);
    })
      .then((fn) => {
        if (alive) unlisten = fn;
        else fn();
      })
      .catch((error) => {
        console.error("[LumaSync] usePreviewStatusSync listen failed:", error);
      });

    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  return preview;
}
