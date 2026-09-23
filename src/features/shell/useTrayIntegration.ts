import { useEffect, useRef, type RefObject } from "react";

import { i18next } from "@/features/i18n/i18n";
import { LIGHTING_MODE_KIND, type LightingModeConfig } from "@/shared/contracts/mode";
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
import {
  listenTrayLightsOff,
  listenTrayResumeLastMode,
  listenTrayShowLedPreview,
  listenTraySolidColor,
} from "@/features/tray/trayController";
import { updateTrayLabels } from "@/features/tray/trayApi";
import type { HueRuntimeTarget } from "@/shared/contracts/hue";

import { loadShellState, saveShellState } from "./windowLifecycle";

export interface TrayIntegrationInput {
  onLightingModeChange: (mode: LightingModeConfig) => Promise<void>;
  lightingModeRef: RefObject<LightingModeConfig>;
  lastNonOffModeRef: RefObject<LightingModeConfig | null>;
  selectedOutputTargetsRef: RefObject<HueRuntimeTarget[]>;
  getSelectedDisplayId: () => string | undefined;
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
 * Registers the tray's three listener sets once. Every handler reads refs
 * rather than state, which is what keeps the `[]` dep arrays honest.
 */
export function useTrayIntegration({
  onLightingModeChange,
  lightingModeRef,
  lastNonOffModeRef,
  selectedOutputTargetsRef,
  getSelectedDisplayId,
  onPreviewOpenFailed,
}: TrayIntegrationInput): void {
  // Assigned during render, never in an effect: a tray event arriving before
  // the effect flush must still reach the current handler.
  const lightingModeChangeRef = useRef(onLightingModeChange);
  lightingModeChangeRef.current = onLightingModeChange;
  const previewOpenFailedRef = useRef(onPreviewOpenFailed);
  previewOpenFailedRef.current = onPreviewOpenFailed;

  // Register i18n languageChanged hook to re-push tray labels
  useEffect(() => {
    const handler = () => pushTrayLabels();
    i18next.on("languageChanged", handler);
    return () => { i18next.off("languageChanged", handler); };
  }, []);

  // Tray quick action listeners (registered once, use refs for fresh state)
  useEffect(() => {
    let alive = true;
    let unlistenOff: (() => void) | null = null;
    let unlistenResume: (() => void) | null = null;
    let unlistenSolid: (() => void) | null = null;

    void Promise.all([
      listenTrayLightsOff(() => {
        const handler = lightingModeChangeRef.current;
        if (handler) void handler({ kind: LIGHTING_MODE_KIND.OFF });
      }),
      listenTrayResumeLastMode(() => {
        const handler = lightingModeChangeRef.current;
        const mode = lastNonOffModeRef.current ?? lightingModeRef.current;
        if (handler && mode.kind !== LIGHTING_MODE_KIND.OFF) {
          void handler({ ...mode, targets: selectedOutputTargetsRef.current });
        }
      }),
      listenTraySolidColor(() => {
        const handler = lightingModeChangeRef.current;
        const currentMode = lightingModeRef.current;
        if (handler) {
          void handler({
            kind: LIGHTING_MODE_KIND.SOLID,
            solid: currentMode.solid ?? { r: 255, g: 255, b: 255, brightness: 1 },
            targets: selectedOutputTargetsRef.current,
          });
        }
      }),
    ])
      .then(([u1, u2, u3]) => {
        // Same unmount-wins-the-race hazard as the effect below: without the
        // guard StrictMode's double-mount leaks a duplicate handler per tray action.
        if (alive) {
          unlistenOff = u1;
          unlistenResume = u2;
          unlistenSolid = u3;
        } else {
          u1();
          u2();
          u3();
        }
      })
      .catch((err) => {
        console.error("[LumaSync] tray quick-action listeners failed to register:", err);
      });

    return () => {
      alive = false;
      unlistenOff?.();
      unlistenResume?.();
      unlistenSolid?.();
    };
  }, [lastNonOffModeRef, lightingModeRef, selectedOutputTargetsRef]);

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
              await openLedTwinOverlay({ scope: "test", displayId: getSelectedDisplayId() }),
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
  }, [getSelectedDisplayId]);
}

export { pushTrayLabels };
