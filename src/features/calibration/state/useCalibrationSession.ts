import { useEffect, useMemo, useRef, useState, useCallback } from "react";

import { shellStore } from "@/features/persistence/shellStore";
import { focusCurrentWindow } from "@/features/shell/windowApi";
import type { LeaveGuard } from "@/features/shell/navigationStore";
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
import type {
  LedCalibrationConfig,
  LedDirection,
  LedSegmentCounts,
  LedSegmentKey,
} from "../model/contracts";
import { sumSegmentCounts } from "../model/contracts";
import {
  CALIBRATION_NOTICE_KEYS,
  noticeDetail,
  overlayBlockedNotice,
  testPatternRefusalNotice,
  type CalibrationNotice,
} from "../model/calibrationNotices";
import { buildLedSequence } from "../model/indexMapping";
import {
  anchorFromEdgeEndpoint,
  edgeOfAnchor,
  endpointOfAnchor,
  type AnchorEdge,
  type AnchorEndpoint,
} from "../model/startAnchor";
import { ALL_EDGES, litEdges, MAX_STRIP_LEDS, splitTotalAcrossEdges } from "../model/splitTotal";
import { resetToManual } from "../model/templates";
import {
  validateCalibrationConfig,
  type CalibrationValidationError,
} from "../model/validation";
import {
  autofillEditorConfig,
  calibrationLayoutKey,
  createCalibrationEditorState,
  isSameCalibrationLayout,
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
import type { DisplayId, DisplayInfo, OverlayPreviewPayload } from "@/shared/contracts/display";
import { LED_CHIP_TYPE, type LedChipType } from "@/shared/contracts/device";
import { clamp } from "@/shared/lib/math";
import { parseCommandError } from "@/shared/contracts/status";

/** Quiet time after the last edit before a running test picks the layout up.
 * Each restart rebuilds the output worker, so a run of clicks is one restart. */
export const TEST_PATTERN_RETUNE_DELAY_MS = 400;

function reclaimFocus() {
  void focusCurrentWindow();
  setTimeout(() => void focusCurrentWindow(), 150);
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

/** The counts and gap a strip total splits into on `display` (16:9 when unknown). */
function splitPatch(
  total: number,
  display: Pick<DisplayInfo, "width" | "height"> | undefined,
  edges: readonly LedSegmentKey[],
  bottomGap: number,
) {
  return splitTotalAcrossEdges({
    total,
    display: display ?? { width: 16, height: 9 },
    edges,
    bottomGap,
  });
}

/** The LED count a bound WLED panel reported, which is the strip's total. */
function reportedStripTotal(ledCount: number | undefined): number | null {
  if (typeof ledCount !== "number" || !Number.isFinite(ledCount) || ledCount <= 0) return null;
  return Math.min(Math.floor(ledCount), MAX_STRIP_LEDS);
}

/** A layout the backend would accept for a test: valid, and more than one LED. */
function isTestableLayout(config: LedCalibrationConfig): boolean {
  return validateCalibrationConfig(config).ok && config.totalLeds > 1;
}

export interface CalibrationSessionOptions {
  initialConfig?: LedCalibrationConfig;
  /**
   * Counts proposed from elsewhere (the room map), applied as an unsaved draft
   * over `initialConfig`. Read once, on mount.
   */
  draftCounts?: LedSegmentCounts | null;
  onNavigateBack: () => void;
  onSaved: (config: LedCalibrationConfig) => void;
  /** Registers the guard that asks before the page is navigated away from. */
  registerLeaveGuard?: (guard: LeaveGuard | null) => void;
}

/** LED Setup's editing session: the editor draft, the display target and its
 * overlay, the test pattern, and the save/close flow. `CalibrationPage` renders it. */
export function useCalibrationSession({
  initialConfig,
  draftCounts,
  onNavigateBack,
  onSaved,
  registerLeaveGuard,
}: CalibrationSessionOptions) {
  const [editorState, setEditorState] = useState<CalibrationEditorState>(() =>
    createCalibrationEditorState(initialConfig ?? resetToManual(), draftCounts),
  );
  const [countsFromRoomMap, setCountsFromRoomMap] = useState(() => Boolean(draftCounts));
  const hasSavedLayout = initialConfig !== undefined && sumSegmentCounts(initialConfig.counts) > 0;
  // With no saved layout the page asks for the strip's total first; the
  // per-edge steppers refine the split it makes.
  const [totalStepOpen, setTotalStepOpen] = useState(() => !hasSavedLayout && !draftCounts);
  const [knownTotal, setKnownTotal] = useState<number | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<CalibrationNotice | null>(null);
  const [chipType, setChipType] = useState<LedChipType>(LED_CHIP_TYPE.WS2812B_GRB);

  const flowRef = useRef(createDefaultTestPatternFlow(initialConfig));
  const [testPattern, setTestPattern] = useState<TestPatternSnapshot>(flowRef.current.getSnapshot());
  const displayTargetRef = useRef(
    createDisplayTargetState({ openDisplayOverlay, closeDisplayOverlay }),
  );
  const [displayTarget, setDisplayTarget] = useState<DisplayTargetSnapshot>(
    displayTargetRef.current.getSnapshot(),
  );
  const [validationErrors, setValidationErrors] = useState<CalibrationValidationError[] | null>(null);
  const [testPatternError, setTestPatternError] = useState<CalibrationNotice | null>(null);
  const [previewOpenFailure, setPreviewOpenFailure] = useState<PreviewOpenFailure | null>(null);

  // Load displays on mount. Honour any persisted selection so the
  // capture source survives app restarts.
  useEffect(() => {
    let cancelled = false;
    Promise.all([listDisplays(), shellStore.load()])
      .then(([displays, shell]) => {
        if (cancelled) return;
        if (shell.selectedChipType === LED_CHIP_TYPE.SK6812_RGBW) setChipType(LED_CHIP_TYPE.SK6812_RGBW);
        let newState = displayTargetRef.current.setDisplays(displays);
        const persisted = shell.selectedDisplayId;
        if (persisted && displays.some((candidate) => candidate.id === persisted)) {
          newState = displayTargetRef.current.selectDisplay(persisted);
        } else if (displays[0] && !newState.selectedDisplayId) {
          newState = displayTargetRef.current.selectDisplay(displays[0].id);
        }
        setDisplayTarget(newState);

        // A bound WLED panel knows its own length, so an empty layout starts
        // from that total split over the selected display. An autofill, not an
        // edit: a first visit that touched nothing must not ask "discard
        // changes?" on Cancel. Without a reported total nothing is guessed —
        // pixels say nothing about how long the strip is.
        const reported = reportedStripTotal(shell.lastWledSink?.ledCount);
        setKnownTotal(reported);
        const selectedId = newState.selectedDisplayId;
        const selectedDisplay = selectedId
          ? displays.find((candidate) => candidate.id === selectedId)
          : undefined;
        if (reported !== null) {
          setEditorState((prev) => {
            if (prev.current.totalLeds !== 0) return prev;
            return autofillEditorConfig(
              prev,
              splitPatch(reported, selectedDisplay, ALL_EDGES, prev.current.bottomMissing),
            );
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

  // Read by the leave guard, which runs outside render. Cleared by hand on the
  // page's own exits (save, discard) so the navigation they trigger is not held.
  const dirtyRef = useRef(editorState.isDirty);
  useEffect(() => {
    dirtyRef.current = editorState.isDirty;
  }, [editorState.isDirty]);
  const pendingLeaveRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!registerLeaveGuard) return;
    registerLeaveGuard((proceed) => {
      if (!dirtyRef.current) return false;
      pendingLeaveRef.current = proceed;
      setEditorState((prev) => ({ ...prev, confirmDiscard: true, shouldClose: false }));
      return true;
    });
    return () => registerLeaveGuard(null);
  }, [registerLeaveGuard]);

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

  const runPreviewToggle = useCallback(async () => {
    const shouldEnable = !flowRef.current.getSnapshot().isEnabled;
    try {
      if (shouldEnable) {
        if (displayTarget.blocked) {
          setTestPatternError({
            key: CALIBRATION_NOTICE_KEYS.testPatternBlocked,
            detail: noticeDetail(displayTarget.blockedCode, displayTarget.blockedReason),
          });
          return;
        }
        const switched = await beginDisplaySwitch(undefined, overlayPreviewPayload);
        setDisplayTarget(switched);
        reclaimFocus();
        if (switched.blocked) {
          setTestPatternError({
            key: CALIBRATION_NOTICE_KEYS.testPatternBlocked,
            detail: noticeDetail(switched.blockedCode, switched.blockedReason),
          });
          return;
        }
      }
      const next = await flowRef.current.toggle(shouldEnable);
      setTestPattern(next);

      // A refused start leaves nothing running, so the overlay must come back
      // down with it — otherwise the editor shows a stage dressed for a test
      // that never began.
      if (shouldEnable && isTestPatternFailure(next.lastStatus)) {
        setTestPatternError(testPatternRefusalNotice(next.lastStatus));
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
      setTestPatternError({
        key: CALIBRATION_NOTICE_KEYS.testPatternToggleFailed,
        detail: noticeDetail(null, reason),
      });
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
  }, [displayTarget, overlayPreviewPayload, beginDisplaySwitch]);

  // Raised for the whole run of a press — the switch, the start or stop (seconds
  // on Hue), and the overlay close after it. The ref is the guard; the state
  // only lets the page show the buttons as waiting.
  const previewToggleRunningRef = useRef(false);
  const [isTogglingTestPattern, setIsTogglingTestPattern] = useState(false);
  // A layout restart in flight. Kept apart from the toggle so a restart does
  // not flash the monitor picker busy; a press waits for neither, it is ignored.
  const retuneRunningRef = useRef(false);

  const handlePreviewToggle = useCallback(async () => {
    // Read from the store, not the render: a second press can land before React
    // has re-rendered with the in-flight snapshot.
    if (
      previewToggleRunningRef.current
      || retuneRunningRef.current
      || displayTargetRef.current.getSnapshot().isSwitching
    ) return;
    previewToggleRunningRef.current = true;
    setIsTogglingTestPattern(true);
    try {
      await runPreviewToggle();
    } finally {
      previewToggleRunningRef.current = false;
      setIsTogglingTestPattern(false);
    }
  }, [runPreviewToggle]);

  // The chase gets its layout once, at start. Without this an edit made while
  // it runs changes the canvas and the overlay but never the strip, which is
  // the one thing the test is for.
  const testLayoutStale =
    testPattern.isEnabled
    && testPattern.layout !== null
    && !isSameCalibrationLayout(testPattern.layout, editorState.current);
  const draftTestable = isTestableLayout(editorState.current);
  // Changes with every edit and every restart, so each one re-arms the
  // debounce — including an edit that lands while a restart is in flight.
  const retuneKey =
    testLayoutStale && draftTestable && testPattern.layout
      ? `${calibrationLayoutKey(testPattern.layout)}→${calibrationLayoutKey(editorState.current)}`
      : null;

  useEffect(() => {
    if (retuneKey === null || isTogglingTestPattern) return;
    const timer = setTimeout(() => {
      if (previewToggleRunningRef.current || retuneRunningRef.current) return;
      retuneRunningRef.current = true;
      void (async () => {
        try {
          const next = await flowRef.current.retune();
          setTestPattern(next);
          if (!next.isEnabled) {
            setTestPatternError(testPatternRefusalNotice(next.lastStatus));
            setDisplayTarget(await displayTargetRef.current.closeActiveDisplay());
          }
        } catch (error) {
          console.error("[LumaSync] LED Setup test restart with the edited layout failed:", error);
          setTestPatternError({
            key: CALIBRATION_NOTICE_KEYS.testPatternToggleFailed,
            detail: noticeDetail(null, parseCommandError(error).message),
          });
        } finally {
          retuneRunningRef.current = false;
        }
      })();
    }, TEST_PATTERN_RETUNE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [retuneKey, isTogglingTestPattern]);

  const handleSelectDisplay = useCallback(async (display: DisplayInfo) => {
    // A pick mid-switch would be saved as the capture source while the overlay
    // lands on the display the switch was already heading for. Mid-toggle the
    // same: a start opens the overlay on the display selected when it began.
    if (previewToggleRunningRef.current || displayTargetRef.current.getSnapshot().isSwitching) return;
    const selected = displayTargetRef.current.selectDisplay(display.id);
    setDisplayTarget(selected);
    // The save is what moves a running capture: Rust re-applies the mode
    // once a setting it reads is saved (lighting-transaction.md).
    void shellStore.save({ selectedDisplayId: display.id }).catch((error) => {
      console.error("[LumaSync] LED Setup could not save the capture display:", error);
    });

    // An untouched automatic split follows the display it was made for.
    if (!hasSavedLayout && !editorState.isDirty && editorState.current.totalLeds > 0) {
      setEditorState((prev) =>
        autofillEditorConfig(
          prev,
          splitPatch(prev.current.totalLeds, display, litEdges(prev.current.counts), prev.current.bottomMissing),
        ),
      );
    }

    if (!testPattern.isEnabled) return;
    try {
      const switched = await beginDisplaySwitch(display.id, overlayPreviewPayload);
      setDisplayTarget(switched);
      reclaimFocus();
      if (switched.blocked) {
        setTestPatternError({
          key: CALIBRATION_NOTICE_KEYS.displaySwitchBlocked,
          detail: noticeDetail(switched.blockedCode, switched.blockedReason),
        });
      } else {
        setTestPatternError(null);
      }
    } catch (error) {
      setTestPatternError({
        key: CALIBRATION_NOTICE_KEYS.displaySwitchFailed,
        detail: noticeDetail(null, parseCommandError(error).message),
      });
    }
  }, [editorState, hasSavedLayout, overlayPreviewPayload, testPattern.isEnabled, beginDisplaySwitch]);

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

  const selectedDisplay = useCallback(() => {
    const snapshot = displayTargetRef.current.getSnapshot();
    return snapshot.displays.find((candidate) => candidate.id === snapshot.selectedDisplayId);
  }, []);

  const handleApplyTotal = useCallback((total: number, edges: readonly LedSegmentKey[]) => {
    const display = selectedDisplay();
    setEditorState((prev) =>
      updateEditorConfig(prev, splitPatch(total, display, edges, prev.current.bottomMissing)),
    );
    setTotalStepOpen(false);
    setCountsFromRoomMap(false);
    setValidationErrors(null);
  }, [selectedDisplay]);

  const handleOpenTotalStep = useCallback(() => setTotalStepOpen(true), []);
  const handleCloseTotalStep = useCallback(() => setTotalStepOpen(false), []);

  // Reset keeps the strip's total — a fact about the hardware — and re-splits
  // it over all four edges. With no total yet it goes back to asking for one.
  const handleReset = useCallback(() => {
    const display = selectedDisplay();
    const total = editorState.current.totalLeds || knownTotal || 0;
    if (total > 0) {
      setEditorState((prev) =>
        updateEditorConfig(prev, splitPatch(total, display, ALL_EDGES, prev.current.bottomMissing)),
      );
    } else {
      setEditorState((prev) => loadEditorConfig(prev, resetToManual()));
      setTotalStepOpen(true);
    }
    setCountsFromRoomMap(false);
    setValidationErrors(null);
  }, [editorState, knownTotal, selectedDisplay]);

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
    setSaveError(null);
    const result = validateCalibrationConfig(editorState.current);
    if (!result.ok) {
      setValidationErrors(result.errors);
      setIsSaving(false);
      return;
    }
    setValidationErrors(null);
    const savedState = saveEditorCalibration(editorState);
    try {
      await shellStore.save({ ledCalibration: savedState.current });
    } catch (error) {
      // The draft stays as it was, so Retry saves exactly what failed.
      console.error("[LumaSync] LED Setup could not save the layout:", error);
      setSaveError({
        key: CALIBRATION_NOTICE_KEYS.saveFailed,
        detail: noticeDetail(null, parseCommandError(error).message),
      });
      setIsSaving(false);
      return;
    }
    try {
      onSaved(savedState.current);
      setEditorState(savedState);
      setCountsFromRoomMap(false);
      dirtyRef.current = false;
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
    pendingLeaveRef.current = null;
    setEditorState((prev) => keepEditing(prev));
  }, []);

  const handleDiscard = useCallback(() => {
    const proceed = pendingLeaveRef.current;
    pendingLeaveRef.current = null;
    dirtyRef.current = false;
    setEditorState((prev) => discardEditorChanges(prev));
    setCountsFromRoomMap(false);
    void flowRef.current.dispose();
    setTestPattern(flowRef.current.getSnapshot());
    // A leave the guard held goes where the user was heading, not to Lights.
    if (proceed) proceed();
    else onNavigateBack();
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

  const overlayBlocked = displayTarget.blocked
    ? overlayBlockedNotice(displayTarget.blockedCode, displayTarget.blockedReason)
    : null;

  return {
    config: editorState.current,
    isDirty: editorState.isDirty,
    confirmDiscard: editorState.confirmDiscard,
    countsFromRoomMap: countsFromRoomMap && editorState.isDirty,
    totalStepOpen,
    knownTotal,
    chipType,
    isSaving,
    saveError,
    testPattern,
    testLayoutStale,
    draftTestable,
    isTogglingTestPattern,
    displayTarget,
    overlayBlocked,
    validationErrors,
    testPatternError,
    previewOpenFailure,
    handlePreviewToggle,
    handleSelectDisplay,
    handleCountChange,
    handleReset,
    handleApplyTotal,
    handleOpenTotalStep,
    handleCloseTotalStep,
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
