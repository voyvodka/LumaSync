import { useEffect, useRef } from "react";

import { i18next } from "@/features/i18n/i18n";
import {
  openLedControlPopup,
  openLedTwinOverlay,
  showLedControlPopup,
} from "@/features/preview/previewApi";
import {
  controlPopupOpenFailure,
  twinOverlayOpenFailure,
  type PreviewOpenFailure,
} from "@/features/preview/previewOpenFailure";
import { listenTrayShowLedPreview } from "@/features/tray/trayController";
import { updateTrayLabels } from "@/features/tray/trayApi";

import { loadShellState, saveShellState } from "./windowLifecycle";

export interface TrayIntegrationInput {
  /** The popup or overlay the tray asked for did not appear. */
  onPreviewOpenFailed?: (failure: PreviewOpenFailure) => void;
}

function pushTrayLabels() {
  void updateTrayLabels({
    openSettings: i18next.t("tray:openSettings"),
    lightsOff: i18next.t("tray:lightsOff"),
    resumeLastMode: i18next.t("tray:resumeLastMode"),
    solidColor: i18next.t("tray:solidColor"),
    showLedPreview: i18next.t("preview:tray.show"),
    closeOverlays: i18next.t("tray:closeOverlays"),
    quit: i18next.t("tray:quit"),
  });
}

/**
 * The tray's labels and its "Show LED Preview" item. The three lighting items
 * (off, resume, solid) run the lighting transaction in Rust and never reach a
 * window, so they work with the window unloaded.
 */
export function useTrayIntegration({ onPreviewOpenFailed }: TrayIntegrationInput): void {
  const previewOpenFailedRef = useRef(onPreviewOpenFailed);
  previewOpenFailedRef.current = onPreviewOpenFailed;

  // Register i18n languageChanged hook to re-push tray labels
  useEffect(() => {
    const handler = () => pushTrayLabels();
    i18next.on("languageChanged", handler);
    return () => { i18next.off("languageChanged", handler); };
  }, []);

  // v1.6 — tray "Show LED Preview" opens (or focuses) the control popup
  // and, when enabled, the digital-twin overlay. Registered once.
  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | null = null;
    void listenTrayShowLedPreview(() => {
      void (async () => {
        // One toast per click: the first failure is the one to act on.
        let reported = false;
        const report = (failure: PreviewOpenFailure | null) => {
          if (!failure || reported) return;
          reported = true;
          previewOpenFailedRef.current?.(failure);
        };
        try {
          const opened = await openLedControlPopup();
          const popupFailure =
            controlPopupOpenFailure(opened) ?? controlPopupOpenFailure(await showLedControlPopup());
          report(popupFailure);
          if (popupFailure === null) await saveShellState({ ledPreviewPopupVisible: true });
          const state = await loadShellState();
          if (state.ledTwinEnabledTest) {
            report(twinOverlayOpenFailure(
              await openLedTwinOverlay({ scope: "test", displayId: state.selectedDisplayId || undefined }),
            ));
          }
        } catch (err) {
          console.error("[LumaSync] tray show-led-preview handler failed:", err);
        }
      })();
    })
      .then((fn) => {
        // Unmount can win the race against listen(); without the guard the
        // handler registers after cleanup ran and never comes off — which
        // StrictMode's double-mount hits on every dev launch.
        if (alive) {
          unlisten = fn;
        } else {
          fn();
        }
      })
      .catch((err) => {
        console.error("[LumaSync] listenTrayShowLedPreview failed:", err);
      });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);
}

export { pushTrayLabels };
