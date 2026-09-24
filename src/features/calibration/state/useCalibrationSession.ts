import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";

import { shellStore } from "@/features/persistence/shellStore";
import { focusCurrentWindow } from "@/features/shell/windowApi";
import {
  openLedTwinOverlay,
  openLedControlPopup,
  showLedControlPopup,
} from "@/features/preview/previewApi";
import {
  controlPopupOpenFailure,
  twinOverlayOpenFailure,
  type PreviewOpenFailure,
} from "@/features/preview/previewOpenFailure";
import type { LedCalibrationConfig, LedDirection } from "../model/contracts";
import { buildLedSequence } from "../model/indexMapping";
import {
  anchorFromEdgeEndpoint,
  edgeOfAnchor,
  endpointOfAnchor,
  type AnchorEdge,
  type AnchorEndpoint,
} from "../model/startAnchor";
import { deriveDefaultCounts, resetToManual } from "../model/templates";
import {
  validateCalibrationConfig,
  type CalibrationValidationError,
} from "../model/validation";
import {
  createCalibrationEditorState,
  keepEditing,
  loadEditorConfig,
  requestEditorClose,
  saveEditorCalibration,
  updateEditorConfig,
  discardEditorChanges,
  type CalibrationEditorState,
} from "./calibrationEditorState";
import {
  closeDisplayOverlay,
  listDisplays,
  openDisplayOverlay,
  updateDisplayOverlayPreview,
} from "../calibrationApi";
import {
  createDefaultTestPatternFlow,
  isTestPatternFailure,
  type TestPatternSnapshot,
} from "./testPatternFlow";
import { createDisplayTargetState, type DisplayTargetSnapshot } from "./displayTargetState";
import {
  DISPLAY_OVERLAY_STATUS,
  type DisplayId,
  type DisplayInfo,
  type OverlayPreviewPayload,
} from "@/shared/contracts/display";
import { LED_TEST_STATUS } from "@/shared/contracts/preview";
import { clamp } from "@/shared/lib/math";
import { parseCommandError } from "@/shared/contracts/status";

function reclaimFocus() {
  void focusCurrentWindow();
  setTimeout(() => void focusCurrentWindow(), 150);
}

function buildInitialEditorState(initialConfig?: LedCalibrationConfig): CalibrationEditorState {
  return createCalibrationEditorState(initialConfig ?? resetToManual());
}

function buildOverlayPreviewPayload(
  config: LedCalibrationConfig,
  sequence: ReturnType<typeof buildLedSequence>,
): OverlayPreviewPayload {
  return {
    counts: { ...config.counts },
    bottomMissing: config.bottomMissing,
    cornerOwnership: config.cornerOwnership,
    visualPreset: config.visualPreset,
    frameMs: 120,
    sequence: sequence.map((item) => ({
      segment: item.segment,
      localIndex: item.localIndex,
    })),
  };
}

export interface CalibrationSessionOptions {
  initialConfig?: LedCalibrationConfig;
  onNavigateBack: () => void;
  onSaved: (config: LedCalibrationConfig) => void;
}

/** LED Setup's editing session: the editor draft, the display target and its
 * overlay, the test pattern, and the save/close flow. `CalibrationPage` renders it. */
export function useCalibrationSession({ initialConfig, onNavigateBack, onSaved }: CalibrationSessionOptions) {
  const { t } = useTranslation();

  const [editorState, setEditorState] = useState<CalibrationEditorState>(() =>
    buildInitialEditorState(initialConfig),
  );
  const [isSaving, setIsSaving] = useState(false);

  const flowRef = useRef(createDefaultTestPatternFlow(initialConfig));
  const [testPattern, setTestPattern] = useState<TestPatternSnapshot>(flowRef.current.getSnapshot());
  const displayTargetRef = useRef(
    createDisplayTargetState({ openDisplayOverlay, closeDisplayOverlay }),
  );
  const [displayTarget, setDisplayTarget] = useState<DisplayTargetSnapshot>(
    displayTargetRef.current.getSnapshot(),
  );
  const [validationErrors, setValidationErrors] = useState<CalibrationValidationError[] | null>(null);
  const [testPatternError, setTestPatternError] = useState<string | null>(null);
  const [previewOpenFailure, setPreviewOpenFailure] = useState<PreviewOpenFailure | null>(null);

  // Load displays on mount. Honour any persisted selection so the
  // capture source survives app restarts.
  useEffect(() => {
    let cancelled = false;
    Promise.all([listDisplays(), shellStore.load()])
      .then(([displays, shell]) => {
        if (cancelled) return;
        let newState = displayTargetRef.current.setDisplays(displays);
        const persisted = shell.selectedDisplayId;
        if (persisted && displays.some((candidate) => candidate.id === persisted)) {
          newState = displayTargetRef.current.selectDisplay(persisted);
        } else if (displays[0] && !newState.selectedDisplayId) {
          newState = displayTargetRef.current.selectDisplay(displays[0].id);
        }
        setDisplayTarget(newState);

        // Auto-derive default LED counts from the resolved capture display
        // if the editor still holds the all-zero \`MANUAL_COUNTS\` baseline.
        // Mirrors the same heuristic that runs on a manual display click in
        // \`handleSelectDisplay\` so cold-start without saved calibration
        // does not leave the dock at 0/0/0/0 until the user changes monitors.
        const selectedId = newState.selectedDisplayId;
        const selectedDisplay = selectedId
          ? displays.find((candidate) => candidate.id === selectedId)
          : undefined;
        if (selectedDisplay) {
          setEditorState((prev) => {
            if (prev.current.totalLeds !== 0) return prev;
            const defaults = deriveDefaultCounts(selectedDisplay);
            return updateEditorConfig(prev, { counts: defaults });
          });
        }
      })
      .catch((error) => {
        if (cancelled) return;
        const reason = parseCommandError(error).message;
        console.warn(`[LumaSync] Display list unavailable: ${reason}`);
        setDisplayTarget(displayTargetRef.current.setDisplays([]));
      });
    return () => { cancelled = true; };
  }, []);

  // Sync editor config to test pattern flow
  useEffect(() => {
    flowRef.current.setConfig(editorState.current);
  }, [editorState.current]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      void flowRef.current.dispose().then(() => {
        void displayTargetRef.current.closeActiveDisplay();
      });
    };
  }, []);

  const sequence = useMemo(() => buildLedSequence(editorState.current), [editorState.current]);
  const overlayPreviewPayload = useMemo(
    () => buildOverlayPreviewPayload(editorState.current, sequence),
    [editorState.current, sequence],
  );

  // Push overlay preview updates
  useEffect(() => {
    if (!testPattern.isEnabled || !displayTarget.activeDisplayId || displayTarget.blocked) return;
    void updateDisplayOverlayPreview(overlayPreviewPayload).then((result) => {
      if (!result.ok) {
        const reason = result.reason ?? result.message;
        console.warn(`[LumaSync] Overlay preview sync skipped (${result.code}): ${reason}`);
      }
    });
  }, [testPattern.isEnabled, displayTarget.activeDisplayId, displayTarget.blocked, overlayPreviewPayload]);

  // The store raises `isSwitching` before its first await and lowers it before
  // the switch settles, so the snapshot a switch resolves to never carries it.
  // Publishing the in-flight one is the only way the page sees a switch running.
  const beginDisplaySwitch = useCallback(
    (displayId: DisplayId | undefined, preview: OverlayPreviewPayload) => {
      const settled = displayTargetRef.current.switchActiveDisplay(displayId, preview);
      setDisplayTarget(displayTargetRef.current.getSnapshot());
      return settled;
    },
    [],
  );

  const handlePreviewToggle = useCallback(async () => {
    // Read from the store, not the render: a second press can land before React
    // has re-rendered with the in-flight snapshot.
    if (displayTargetRef.current.getSnapshot().isSwitching) return;
    const shouldEnable = !testPattern.isEnabled;
    try {
      if (shouldEnable) {
        if (displayTarget.blocked) {
          const reason = displayTarget.blockedReason ?? t("calibration:overlay.blockedReasonUnknown");
          const code = displayTarget.blockedCode ?? DISPLAY_OVERLAY_STATUS.OPEN_FAILED;
          setTestPatternError(t("calibration:overlay.errors.testPatternBlocked", { code, reason }));
          return;
        }
        const switched = await beginDisplaySwitch(undefined, overlayPreviewPayload);
        setDisplayTarget(switched);
        reclaimFocus();
        if (switched.blocked) {
          const reason = switched.blockedReason ?? t("calibration:overlay.blockedReasonUnknown");
          const code = switched.blockedCode ?? DISPLAY_OVERLAY_STATUS.OPEN_FAILED;
          setTestPatternError(t("calibration:overlay.errors.testPatternBlocked", { code, reason }));
          return;
        }
      }
      const next = await flowRef.current.toggle(shouldEnable);
      setTestPattern(next);

      // A refused start leaves nothing running, so the overlay must come back
      // down with it — otherwise the editor shows a stage dressed for a test
      // that never began.
      if (shouldEnable && isTestPatternFailure(next.lastStatus)) {
        setTestPatternError(
          next.lastStatus === LED_TEST_STATUS.PATTERN_NO_CALIBRATION
            ? t("calibration:overlay.errors.testPatternNoCalibration")
            : t("calibration:overlay.errors.testPatternRefused", { code: next.lastStatus }),
        );
        const closed = await displayTargetRef.current.closeActiveDisplay();
        setDisplayTarget(closed);
        return;
      }

      setTestPatternError(null);
      if (!shouldEnable) {
        const closed = await displayTargetRef.current.closeActiveDisplay();
        setDisplayTarget(closed);
      } else {
        setDisplayTarget(displayTargetRef.current.clearBlockedState());
      }
    } catch (error) {
      const reason = parseCommandError(error).message;
      setTestPatternError(t("calibration:overlay.errors.testPatternToggleFailed", { reason }));
      // Best-effort rollback: testPatternError above already tells the user what
      // failed, so a failing rollback must not overwrite it with a second message.
      // Logged at debug level so the swallow is still visible in the log sink.
      try {
        const s = await flowRef.current.toggle(false);
        setTestPattern(s);
      } catch (rollbackError) {
        console.debug(`[LumaSync] Test pattern rollback failed: ${parseCommandError(rollbackError).message}`);
      }
      try {
        const c = await displayTargetRef.current.closeActiveDisplay();
        setDisplayTarget(c);
      } catch (rollbackError) {
        console.debug(`[LumaSync] Overlay close after failure did not complete: ${parseCommandError(rollbackError).message}`);
      }
    }
  }, [testPattern.isEnabled, displayTarget, overlayPreviewPayload, beginDisplaySwitch, t]);

  const handleSelectDisplay = useCallback(async (display: DisplayInfo) => {
    // A pick mid-switch would be saved as the capture source while the overlay
    // lands on the display the switch was already heading for.
    if (displayTargetRef.current.getSnapshot().isSwitching) return;
    const selected = displayTargetRef.current.selectDisplay(display.id);
    setDisplayTarget(selected);
    // The save is what moves a running capture: Rust re-applies the mode
    // once a setting it reads is saved (lighting-transaction.md).
    void shellStore.save({ selectedDisplayId: display.id });

    // Auto-derive default counts only when the user hasn't customized yet
    // (fresh manual default → totalLeds === 0).
    if (editorState.current.totalLeds === 0) {
      const defaults = deriveDefaultCounts(display);
      setEditorState((prev) => updateEditorConfig(prev, { counts: defaults }));
    }

    if (!testPattern.isEnabled) return;
    try {
      const switched = await beginDisplaySwitch(display.id, overlayPreviewPayload);
      setDisplayTarget(switched);
      reclaimFocus();
      if (switched.blocked) {
        const reason = switched.blockedReason ?? t("calibration:overlay.blockedReasonUnknown");
        const code = switched.blockedCode ?? DISPLAY_OVERLAY_STATUS.OPEN_FAILED;
        setTestPatternError(t("calibration:overlay.errors.displaySwitchBlocked", { code, reason }));
      } else {
        setTestPatternError(null);
      }
    } catch (error) {
      const reason = parseCommandError(error).message;
      setTestPatternError(t("calibration:overlay.errors.displaySwitchFailed", { reason }));
    }
  }, [editorState, overlayPreviewPayload, testPattern.isEnabled, beginDisplaySwitch, t]);

  // Accept the absolute next value, not a delta. Stepper buttons
  // pass `value + 1` / `value - 1` so the +/- affordance is preserved
  // while the new keyboard-input path can submit any integer directly.
  // Defensive cap at 1000 — the build still validates totalLeds downstream
  // for protocol-specific budgets, but a hard upper bound here stops a
  // typo (e.g. an extra trailing digit) from blowing up the editor state.
  const handleCountChange = useCallback((segment: "top" | "right" | "bottom" | "left", nextValue: number) => {
    setEditorState((prev) => {
      const clamped = clamp(Math.floor(nextValue), 0, 1000);
      return updateEditorConfig(prev, { counts: { [segment]: clamped } });
    });
    setValidationErrors(null);
  }, []);

  const handleReset = useCallback(() => {
    const display = displayTarget.displays.find((candidate) => candidate.id === displayTarget.selectedDisplayId);
    if (display) {
      const defaults = deriveDefaultCounts(display);
      setEditorState((prev) => updateEditorConfig(prev, { counts: defaults }));
    } else {
      setEditorState((prev) => loadEditorConfig(prev, resetToManual()));
    }
    setValidationErrors(null);
  }, [displayTarget]);

  // Accept the absolute next value, not a delta. Same shape as
  // handleCountChange so StandGapStepper can use the unified API.
  const handleBottomMissingChange = useCallback((nextValue: number) => {
    setEditorState((prev) => {
      const max = prev.current.counts.bottom;
      const next = Math.max(0, Math.min(max, Math.floor(nextValue)));
      return updateEditorConfig(prev, { bottomMissing: next });
    });
    setValidationErrors(null);
  }, []);

  const handleDirectionChange = useCallback((direction: LedDirection) => {
    setEditorState((prev) => updateEditorConfig(prev, { direction }));
    setValidationErrors(null);
  }, []);

  const handleEdgeChange = useCallback((edge: AnchorEdge) => {
    setEditorState((prev) => {
      if (prev.current.counts[edge] === 0) return prev;
      const currentEndpoint = endpointOfAnchor(prev.current.startAnchor);
      const keep = currentEndpoint === "end" ? "end" : "start";
      return updateEditorConfig(prev, { startAnchor: anchorFromEdgeEndpoint(edge, keep) });
    });
    setValidationErrors(null);
  }, []);

  const handleEndpointChange = useCallback((endpoint: AnchorEndpoint) => {
    setEditorState((prev) => {
      const edge = edgeOfAnchor(prev.current.startAnchor);
      return updateEditorConfig(prev, { startAnchor: anchorFromEdgeEndpoint(edge, endpoint) });
    });
    setValidationErrors(null);
  }, []);

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    const result = validateCalibrationConfig(editorState.current);
    if (!result.ok) {
      setValidationErrors(result.errors);
      setIsSaving(false);
      return;
    }
    setValidationErrors(null);
    try {
      const savedState = saveEditorCalibration(editorState);
      await shellStore.save({ ledCalibration: savedState.current });
      onSaved(savedState.current);
      setEditorState(savedState);
      await flowRef.current.dispose();
      setTestPattern(flowRef.current.getSnapshot());
      onNavigateBack();
    } finally {
      setIsSaving(false);
    }
  }, [editorState, onNavigateBack, onSaved]);

  const handleClose = useCallback(() => {
    const closeState = requestEditorClose(editorState);
    setEditorState(closeState);
    if (closeState.shouldClose) {
      void flowRef.current.dispose();
      setTestPattern(flowRef.current.getSnapshot());
      onNavigateBack();
    }
  }, [editorState, onNavigateBack]);

  const handleKeepEditing = useCallback(() => {
    setEditorState((prev) => keepEditing(prev));
  }, []);

  const handleDiscard = useCallback(() => {
    setEditorState((prev) => discardEditorChanges(prev));
    void flowRef.current.dispose();
    setTestPattern(flowRef.current.getSnapshot());
    onNavigateBack();
  }, [onNavigateBack]);

  // v1.6 — launch the LED preview surface (click-through digital-twin
  // overlay + interactive control popup) straight from LED Setup. The
  // preview API never throws; the try/catch guards the shellStore write.
  const handleOpenPreview = useCallback(async () => {
    setPreviewOpenFailure(null);
    try {
      // Without an explicit id Rust falls back to the primary display, which
      // strands the overlay on the wrong monitor for a non-primary selection.
      const overlayFailure = twinOverlayOpenFailure(
        await openLedTwinOverlay({
          scope: "test",
          displayId: displayTargetRef.current.getSnapshot().selectedDisplayId ?? undefined,
        }),
      );
      const popupFailure =
        controlPopupOpenFailure(await openLedControlPopup())
        ?? controlPopupOpenFailure(await showLedControlPopup());
      setPreviewOpenFailure(overlayFailure ?? popupFailure);
      await shellStore.save({
        ...(popupFailure === null ? { ledPreviewPopupVisible: true } : {}),
        ledTwinEnabledTest: true,
      });
    } catch (err) {
      console.error("[LumaSync] open LED preview from setup failed:", err);
    }
  }, []);

  return {
    config: editorState.current,
    confirmDiscard: editorState.confirmDiscard,
    isSaving,
    testPattern,
    displayTarget,
    validationErrors,
    testPatternError,
    previewOpenFailure,
    handlePreviewToggle,
    handleSelectDisplay,
    handleCountChange,
    handleReset,
    handleBottomMissingChange,
    handleDirectionChange,
    handleEdgeChange,
    handleEndpointChange,
    handleSave,
    handleClose,
    handleKeepEditing,
    handleDiscard,
    handleOpenPreview,
  };
}
