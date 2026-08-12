/**
 * useLightingModeSync — cross-window lighting + preview reconciliation.
 *
 * The control popup is a SEPARATE webview from the main window, so it cannot
 * read App.tsx's in-memory mode state. Instead it listens to two broadcast
 * channels emitted by the Rust runtime:
 *
 *   - `lighting://mode-changed` — fired on every mode flip / solid update /
 *     ambilight start-stop, carrying the live `LightingModeConfig` + `active`.
 *   - `preview://state-changed` — fired whenever the preview runtime changes
 *     (test started/stopped, overlay opened/closed, popup shown/hidden),
 *     carrying a `LedPreviewStatus` snapshot.
 *
 * Both are seeded once on mount via `get_lighting_mode_status` /
 * `get_led_preview_status` so the popup renders the correct state immediately
 * even if it opened mid-session (no event has fired yet).
 */

import { useEffect, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import {
  LIGHTING_MODE_CHANGED_EVENT,
  type LightingModeChangedPayload,
  type LightingModeConfig,
} from "@/features/mode/model/contracts";
import {
  PREVIEW_STATE_CHANGED_EVENT,
  type LedPreviewStatus,
} from "@/shared/contracts/preview";
import { getLightingModeStatus } from "@/features/mode/modeApi";
import { getLedPreviewStatus } from "../previewApi";

/** Live lighting mode + preview snapshot as seen by a webview separate from the main window. */
export interface LightingModeSyncState {
  /** Live lighting mode config, or `null` until the first sync resolves. */
  mode: LightingModeConfig | null;
  /** Whether lighting is actively driving sinks. */
  active: boolean;
  /** Latest preview runtime snapshot, or `null` until the first sync. */
  preview: LedPreviewStatus | null;
}

/** Seeds and keeps `LightingModeSyncState` in sync via the mode/preview broadcast events. */
export function useLightingModeSync(): LightingModeSyncState {
  const [mode, setMode] = useState<LightingModeConfig | null>(null);
  const [active, setActive] = useState(false);
  const [preview, setPreview] = useState<LedPreviewStatus | null>(null);

  useEffect(() => {
    let alive = true;
    const unlistens: UnlistenFn[] = [];

    // Seed initial state so the popup is correct on first paint.
    void getLightingModeStatus()
      .then((result) => {
        if (!alive) return;
        setMode(result.mode);
        setActive(result.active);
      })
      .catch((error) => {
        console.error("[LumaSync] useLightingModeSync initial mode read failed:", error);
      });

    void getLedPreviewStatus()
      .then((status) => {
        if (alive) setPreview(status);
      })
      .catch((error) => {
        console.error("[LumaSync] useLightingModeSync initial preview read failed:", error);
      });

    listen<LightingModeChangedPayload>(LIGHTING_MODE_CHANGED_EVENT, (event) => {
      setMode(event.payload.config);
      setActive(event.payload.active);
    })
      .then((fn) => {
        if (alive) unlistens.push(fn);
        else fn();
      })
      .catch((error) => {
        console.error("[LumaSync] useLightingModeSync mode listen failed:", error);
      });

    listen<LedPreviewStatus>(PREVIEW_STATE_CHANGED_EVENT, (event) => {
      setPreview(event.payload);
    })
      .then((fn) => {
        if (alive) unlistens.push(fn);
        else fn();
      })
      .catch((error) => {
        console.error("[LumaSync] useLightingModeSync preview listen failed:", error);
      });

    return () => {
      alive = false;
      for (const fn of unlistens) fn();
    };
  }, []);

  return { mode, active, preview };
}
