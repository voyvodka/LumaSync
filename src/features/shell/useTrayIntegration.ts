import { useEffect, useRef } from "react";
import type { TFunction } from "i18next";

import { i18next } from "@/features/i18n/i18n";
import { modeKind } from "@/features/mode/model/modeKinds";
import { LIGHTING_MODE_KIND, type LightingModeKind } from "@/shared/contracts/mode";
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

/** An output as the tray names it: the `usb` target is WLED when a panel drives it. */
export type TrayOutput = "usb" | "wled" | "hue";

/** What the tray's status line says: the running mode and what it reaches. */
export interface TrayStatus {
  mode: LightingModeKind;
  outputs: readonly TrayOutput[];
}

const TRAY_OUTPUT_LABEL = {
  usb: "common:hotplug.targetLabel.usb",
  wled: "common:hotplug.wledLabel",
  hue: "common:hotplug.targetLabel.hue",
} as const satisfies Record<TrayOutput, string>;

/** The tray's status line, e.g. "● Ambilight · USB + Hue". Pure, for tests. */
export function trayStatusLabel(status: TrayStatus, t: TFunction): string {
  if (status.mode === LIGHTING_MODE_KIND.OFF) return t("tray:status.off");
  const mode = t(modeKind(status.mode).labelKey);
  if (status.outputs.length === 0) return t("tray:status.runningNoOutputs", { mode });
  const outputs = status.outputs.map((output) => t(TRAY_OUTPUT_LABEL[output])).join(" + ");
  return t("tray:status.running", { mode, outputs });
}

export interface TrayIntegrationInput {
  /** The popup or overlay the tray asked for did not appear. */
  onPreviewOpenFailed?: (failure: PreviewOpenFailure) => void;
  /** What the tray's status line reports; pushed whenever it changes. */
  status?: TrayStatus;
  /** The modes the main window's own mode buttons have disabled; the tray greys the same. */
  lockedModes?: readonly LightingModeKind[];
}

// Module state because the boot path pushes the labels too, before any mode
// is known; that push must not reset a status a render already set.
let trayStatus: TrayStatus = { mode: LIGHTING_MODE_KIND.OFF, outputs: [] };
let trayLockedModes: LightingModeKind[] = [];

function pushTrayLabels() {
  const t = i18next.t.bind(i18next) as TFunction;
  updateTrayLabels({
    openSettings: t("tray:openSettings"),
    status: trayStatusLabel(trayStatus, t),
    lightsOff: t("tray:lightsOff"),
    ambilight: t("tray:ambilight"),
    solidColor: t("tray:solidColor"),
    lockedModes: trayLockedModes,
    showLedPreview: t("preview:tray.show"),
    closeOverlays: t("tray:closeOverlays"),
    quit: t("tray:quit"),
  }).catch((err: unknown) => {
    console.error("[LumaSync] pushing the tray labels failed:", err);
  });
}

/**
 * The tray's labels and its "Show LED Preview" item. The mode check group
 * (off, Ambilight, solid) runs the lighting transaction in Rust and never
 * reaches a window, so it works with the window unloaded; Rust checks the
 * running mode itself, and greys what this window says it has locked.
 */
export function useTrayIntegration({ onPreviewOpenFailed, status, lockedModes }: TrayIntegrationInput): void {
  const previewOpenFailedRef = useRef(onPreviewOpenFailed);
  previewOpenFailedRef.current = onPreviewOpenFailed;

  const statusMode = status?.mode ?? null;
  const statusOutputs = status?.outputs.join(",") ?? "";
  const locked = lockedModes?.join(",") ?? null;
  useEffect(() => {
    if (statusMode === null && locked === null) return;
    if (statusMode !== null) {
      trayStatus = {
        mode: statusMode,
        outputs: statusOutputs === "" ? [] : (statusOutputs.split(",") as TrayOutput[]),
      };
    }
    if (locked !== null) {
      trayLockedModes = locked === "" ? [] : (locked.split(",") as LightingModeKind[]);
    }
    pushTrayLabels();
  }, [statusMode, statusOutputs, locked]);

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
