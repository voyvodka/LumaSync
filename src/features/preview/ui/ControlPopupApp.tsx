// ControlPopupApp — root of the `led-control-popup` webview, the preview
// session's remote. Opening it changes no light. Its mode strip is a lighting
// choice like the main window's: the Rust transaction runs it, on the saved
// outputs, and saves it. Close ends the session; Hide keeps it open.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { shellStore } from "@/features/persistence/shellStore";
import {
  onCurrentWindowMoved,
  readCurrentWindowLogicalCenter,
  type UnlistenFn,
} from "@/features/shell/windowApi";
import { usePreference } from "@/features/persistence/preferences";
import { modeKind } from "@/features/mode/model/modeKinds";
import { ModeStage } from "@/features/mode/ui/ModeStage";
import { ModeStrip } from "@/features/mode/ui/ModeStrip";
import { applyOutputs, retuneLighting } from "@/features/mode/modeApi";
import { isOutputsApplied, needsCalibration } from "@/features/mode/state/modeApplyOutcome";
import { choiceFailureMessage } from "@/features/shell/notices/choiceFailureMessage";
import { createRetuneCoalescer, tuningOf } from "@/features/mode/state/retuneCoalescer";
import { useLightingRuntime } from "@/features/mode/state/useLightingRuntime";
import { LIGHTING_MODE_KIND, type LightingModeConfig, type LightingModeKind } from "@/shared/contracts/mode";
import { LIGHTING_ORIGIN } from "@/shared/contracts/lightingRuntime";
import {
  PREVIEW_STATUS,
  type PreviewSessionStatusCode,
  type SceneKind,
} from "@/shared/contracts/preview";
import type { TranslationKey } from "@/features/i18n/catalogue";
import { IconButton } from "@/shared/ui/IconButton/IconButton";
import { IconClose, IconEye, IconEyeOff, IconMinus } from "@/shared/ui/icons";
import {
  closePreview,
  setPreviewPopupHidden,
  setPreviewSceneBrightness,
  setPreviewTwinHidden,
  startPreviewScene,
  stopPreviewScene,
} from "../previewApi";
import { createLatestSender } from "../state/latestSender";
import { useLatencyResult } from "../state/useLatencyResult";
import { usePopupStage } from "../state/usePopupStage";
import { usePreviewSession } from "../state/usePreviewSession";
import { PopupBrightnessRow } from "./PopupBrightnessRow";
import { PopupLatencyRow } from "./PopupLatencyRow";
import { PopupScenePicker } from "./PopupScenePicker";
import styles from "./ControlPopupApp.module.css";

/** Trailing window for popup-centre writes so a window drag hits disk once. */
const PERSIST_CENTER_DEBOUNCE_MS = 400;

/** What a scene start or stop that did not happen says. */
const SCENE_FAILURES: Partial<Record<PreviewSessionStatusCode, TranslationKey>> = {
  [PREVIEW_STATUS.SCENE_NO_OUTPUT]: "preview:status.PREVIEW_SCENE_NO_OUTPUT",
  [PREVIEW_STATUS.SCENE_CAPTURE_DENIED]: "preview:status.PREVIEW_SCENE_CAPTURE_DENIED",
  [PREVIEW_STATUS.SCENE_START_FAILED]: "preview:status.PREVIEW_SCENE_START_FAILED",
  [PREVIEW_STATUS.SCENE_TEST_PATTERN_ACTIVE]: "preview:status.PREVIEW_SCENE_TEST_PATTERN_ACTIVE",
  [PREVIEW_STATUS.DISPLAY_NOT_FOUND]: "preview:status.PREVIEW_DISPLAY_NOT_FOUND",
  [PREVIEW_STATUS.RESTORE_FAILED]: "preview:status.PREVIEW_RESTORE_FAILED",
};

export function ControlPopupApp() {
  const { t } = useTranslation();
  const { snapshot, adopt } = useLightingRuntime();
  const session = usePreviewSession();
  const mode = snapshot?.mode ?? null;
  const retunes = useMemo(() => createRetuneCoalescer((tuning) => retuneLighting(tuning)), []);
  const sendSceneBrightness = useMemo(() => createLatestSender(setPreviewSceneBrightness), []);
  const [runError, setRunError] = useState<string | null>(null);
  const [sceneBusy, setSceneBusy] = useState(false);
  const playing = session?.state === "scene" ? session : null;
  const latency = useLatencyResult(playing?.scene === "latency");

  // ── Persist the popup centre so it reopens where the user left it ────────
  useEffect(() => {
    let alive = true;
    let timer: number | null = null;
    let unlisten: UnlistenFn | null = null;

    const persist = () => {
      if (timer !== null) return;
      timer = window.setTimeout(() => {
        timer = null;
        void (async () => {
          try {
            // Rust restores through LogicalPosition, so store logical px —
            // unlike the main window, whose centre is persisted in physical px.
            const center = await readCurrentWindowLogicalCenter();
            if (!alive) return;
            await shellStore.save({
              ledPreviewPopupCenterX: Math.round(center.x),
              ledPreviewPopupCenterY: Math.round(center.y),
            });
          } catch (error) {
            console.error("[LumaSync] ControlPopupApp persist popup centre failed:", error);
          }
        })();
      }, PERSIST_CENTER_DEBOUNCE_MS);
    };

    void onCurrentWindowMoved(persist)
      .then((fn) => {
        if (alive) unlisten = fn;
        else fn();
      })
      .catch((error) => {
        console.error("[LumaSync] ControlPopupApp move listener failed:", error);
      });

    return () => {
      alive = false;
      if (timer !== null) window.clearTimeout(timer);
      unlisten?.();
    };
  }, []);

  const kind = mode?.kind ?? LIGHTING_MODE_KIND.OFF;
  const stage = usePopupStage(snapshot);
  const lastLit = usePreference("lastLitKind");

  // ── Mode strip ───────────────────────────────────────────────────────────
  const handleModeClick = useCallback(
    (next: LightingModeKind) => {
      setRunError(null);
      void (async () => {
        try {
          retunes.reset();
          // The kind alone: Rust keeps each mode's last settings. The colour
          // itself is chosen on Lights.
          const result = await applyOutputs({
            mode: modeKind(next).config({}),
            origin: LIGHTING_ORIGIN.POPUP,
          });
          adopt(result.snapshot);
          if (needsCalibration(result)) {
            setRunError(t("preview:control.calibrationRequired"));
          } else if (!isOutputsApplied(result)) {
            // Said here, in the main window's words: a choice that changed
            // nothing used to change nothing on screen either.
            const failure = choiceFailureMessage(result, t);
            if (failure !== null) {
              setRunError(failure);
              console.warn(
                `[LumaSync] ControlPopupApp mode ${next}: ${result.status.code}`,
                result.status.details ?? "",
              );
            }
          }
        } catch (error) {
          console.error("[LumaSync] ControlPopupApp mode change failed:", error);
        }
      })();
    },
    [adopt, retunes, t],
  );

  // ── The stage: the compact window's settings, retunes of the running mode ─
  // The stage only edits the mode that runs (dimmed and out of reach under Off), so every change is
  // a retune, coalesced like a drag on Lights.
  const handleStageChange = (next: LightingModeConfig) => {
    if (next.kind !== kind) return;
    const tuning = tuningOf(next);
    if (tuning) retunes.push(tuning);
  };

  // ── Scenes: a press plays one; the playing one's press stops it ──────────
  const handleScene = (scene: SceneKind) => {
    setRunError(null);
    setSceneBusy(true);
    const request = playing?.scene === scene ? stopPreviewScene() : startPreviewScene(scene);
    void request
      .then((result) => {
        const failure = SCENE_FAILURES[result.status.code];
        if (failure !== undefined) {
          setRunError(t(failure));
          console.warn(`[LumaSync] ControlPopupApp scene ${scene}: ${result.status.code}`, result.status.details ?? "");
        }
      })
      .finally(() => setSceneBusy(false));
  };

  // ── Twin, hide and close ─────────────────────────────────────────────────
  const live = session?.state === "live" || session?.state === "scene" ? session : null;
  const twinHidden = live?.twinHidden ?? false;
  // Switched on but off screen: the capture holds it where nothing can keep it out of the frame.
  const twinHeld = !twinHidden && (live?.twinHeldForCapture ?? false);
  const twinLabel = twinHidden ? t("preview:control.twinShow") : t("preview:control.twinHide");
  const handleTwin = () => {
    void setPreviewTwinHidden(!twinHidden);
  };

  // Close ends the session in Rust, which destroys this window and the twin;
  // only a failure leaves anything here to show.
  const handleClose = useCallback(() => {
    void closePreview().then((result) => {
      if (result.status.code === PREVIEW_STATUS.CLOSE_FAILED) {
        setRunError(t("preview:status.PREVIEW_CLOSE_FAILED"));
      }
    });
  }, [t]);

  const handleHide = useCallback(() => {
    void setPreviewPopupHidden(true);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) handleClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleClose]);

  return (
    <div className={styles.root}>
      <header className={styles.header} data-tauri-drag-region>
        <span className={styles.title} data-tauri-drag-region>
          {t("preview:title")}
        </span>
        <IconButton
          className={styles.headerButton}
          label={twinLabel}
          icon={twinHidden || twinHeld ? <IconEyeOff /> : <IconEye />}
          onClick={handleTwin}
          data-testid="popup-twin"
        />
        <IconButton
          className={styles.headerButton}
          label={t("preview:control.hide")}
          title={t("preview:control.hideHint")}
          icon={<IconMinus />}
          onClick={handleHide}
        />
        <IconButton
          className={styles.headerButton}
          label={t("preview:control.close")}
          title={t("preview:control.closeHint")}
          icon={<IconClose />}
          onClick={handleClose}
        />
      </header>

      <div className={styles.body}>
        {twinHeld && (
          <p className={styles.held} role="status" data-testid="popup-twin-held">
            {t("preview:control.twinHeld")}
          </p>
        )}
        <PopupScenePicker playing={playing?.scene ?? null} busy={sceneBusy} onPick={handleScene} />
        {playing?.scene === "latency" && <PopupLatencyRow result={latency} />}
        {/* The scene has the lights, so no mode is marked; any press is a choice, and it ends the scene. */}
        <ModeStrip variant="popup" value={playing ? null : kind} onSelect={handleModeClick} />
        {/* A scene's brightness is its own and never saved; the mode's settings wait until it stops. */}
        {playing ? (
          <PopupBrightnessRow brightness={playing.sceneBrightness} onChange={sendSceneBrightness} />
        ) : (
          <div data-lights className={styles.stage}>
            <ModeStage
              dense
              mode={stage.mode}
              disabled={false}
              brightnessLocked={stage.brightnessLocked}
              brightnessTitle={stage.brightnessTitle}
              onModeChange={handleStageChange}
              lastLit={lastLit}
              onTurnOn={() => handleModeClick(lastLit)}
            />
          </div>
        )}
        {runError && (
          <p className={styles.error} role="alert">
            {runError}
          </p>
        )}
      </div>
    </div>
  );
}
