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
  LedSegmentKey,
} from "../model/contracts";
import {
  distribute,
  draftFromCounts,
  setCount,
  setStand,
  toggleEdge,
  toggleLink,
  MAX_COUNT,
  type CountKey,
  type DisplayAspect,
  type LinkedPair,
} from "../model/ledLayout";
import {
  nudge,
  pickCorner,
  pickEnd,
  pickLed,
  setDirection,
  type Corner,
  type LedRef,
  type StartPoint,
} from "../model/startPoint";
import { sumSegmentCounts } from "../model/contracts";
import {
  CALIBRATION_NOTICE_KEYS,
  noticeDetail,
  overlayBlockedNotice,
  testPatternRefusalNotice,
  type CalibrationNotice,
} from "../model/calibrationNotices";
import { buildLedSequence } from "../model/indexMapping";
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
  saveEditorCalibration,
  discardEditorChanges,
  type CalibrationEditorState,
} from "./calibrationEditorState";
import {
  commitLayout,
  draftOf,
  layoutPatch,
  layoutUiFrom,
  startOf,
  type LayoutUi,
  type StartRule,
} from "./layoutEdit";
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

const UNKNOWN_DISPLAY: DisplayAspect = { width: 16, height: 9 };

const aspectOf = (display: Pick<DisplayInfo, "width" | "height"> | undefined): DisplayAspect =>
  display && display.width > 0 && display.height > 0 ? display : UNKNOWN_DISPLAY;

/** A total shared over the edges the layout lights (all four when it lights none), as an autofill patch. */
function distributedPatch(config: LedCalibrationConfig, ui: LayoutUi, total: number, display: DisplayAspect) {
  const draft = distribute(draftOf(config, ui), total, display);
  return layoutPatch(config, ui, draft, { kind: "hold" });
}

/** The LED count a bound WLED panel reported, which is the strip's total. */
function reportedStripTotal(ledCount: number | undefined): number | null {
  if (typeof ledCount !== "number" || !Number.isFinite(ledCount) || ledCount <= 0) return null;
  return Math.min(Math.floor(ledCount), MAX_COUNT);
}

/** A layout the backend would accept for a test: valid, and more than one LED. */
function isTestableLayout(config: LedCalibrationConfig): boolean {
  return validateCalibrationConfig(config).ok && config.totalLeds > 1;
}

export interface CalibrationSessionOptions {
  initialConfig?: LedCalibrationConfig;
  onNavigateBack: () => void;
  onSaved: (config: LedCalibrationConfig) => void;
  /** Registers the guard that asks before the page is navigated away from. */
  registerLeaveGuard?: (guard: LeaveGuard | null) => void;
}

/** LED Setup's editing session: the editor draft, the display target and its
 * overlay, the test pattern, and the save/close flow. `CalibrationPage` renders it. */
export function useCalibrationSession({
  initialConfig,
  onNavigateBack,
  onSaved,
  registerLeaveGuard,
}: CalibrationSessionOptions) {
  const [editorState, setEditorState] = useState<CalibrationEditorState>(() =>
    createCalibrationEditorState(initialConfig ?? resetToManual()),
  );
  const hasSavedLayout = initialConfig !== undefined && sumSegmentCounts(initialConfig.counts) > 0;
  // With no saved layout the page asks for the strip's total first; the
  // per-edge rows refine the split it makes.
  const [firstRun, setFirstRun] = useState(() => !hasSavedLayout);
  // A layout never saved can be saved as it stands (a WLED fill is not an edit).
  const [savedOnce, setSavedOnce] = useState(hasSavedLayout);
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const [layoutUi, setLayoutUi] = useState<LayoutUi>(() => layoutUiFrom(editorState.current));
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
            const { patch } = distributedPatch(prev.current, layoutUiFrom(prev.current), reported, aspectOf(selectedDisplay));
            return autofillEditorConfig(prev, patch);
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

  // Links and "Özel" are derived from counts whenever the baseline moves under
  // the page (autofill, discard, a reload) — never on an ordinary edit, which
  // leaves the baseline alone. Keyed by content: the object is rebuilt per edit.
  // A save moves the baseline to what is on screen already, so it keeps them.
  // Set during render, not in an effect, so the page never paints stale links.
  const baselineKey = calibrationLayoutKey(editorState.baseline);
  const [uiBaselineKey, setUiBaselineKey] = useState(baselineKey);
  const [keepUiFor, setKeepUiFor] = useState<string | null>(null);
  if (uiBaselineKey !== baselineKey) {
    setUiBaselineKey(baselineKey);
    if (keepUiFor !== baselineKey) setLayoutUi(layoutUiFrom(editorState.baseline));
  }

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
      const { patch } = distributedPatch(editorState.current, layoutUi, editorState.current.totalLeds, aspectOf(display));
      setEditorState((prev) => autofillEditorConfig(prev, patch));
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
  }, [editorState, hasSavedLayout, layoutUi, overlayPreviewPayload, testPattern.isEnabled, beginDisplaySwitch]);

  const displayAspect = useCallback((): DisplayAspect => {
    const snapshot = displayTargetRef.current.getSnapshot();
    return aspectOf(snapshot.displays.find((candidate) => candidate.id === snapshot.selectedDisplayId));
  }, []);

  /** Every layout or start edit goes through here: model step, then back into the saved shape. */
  const edit = useCallback(
    (step: (draft: ReturnType<typeof draftOf>, start: StartPoint) => { draft?: ReturnType<typeof draftOf>; rule: StartRule }) => {
      const draft = draftOf(editorState.current, layoutUi);
      const result = step(draft, startOf(editorState.current));
      const committed = commitLayout(editorState, layoutUi, result.draft ?? draft, result.rule);
      setEditorState(committed.state);
      setLayoutUi(committed.ui);
      setValidationErrors(null);
    },
    [editorState, layoutUi],
  );

  const handleEdgeToggle = useCallback((edge: LedSegmentKey, lit: boolean) => {
    edit((draft) => ({ draft: toggleEdge(draft, edge, lit, displayAspect()), rule: { kind: "layout" } }));
  }, [edit, displayAspect]);

  const handleCountChange = useCallback((key: CountKey, value: number) => {
    edit((draft) => ({ draft: setCount(draft, key, value, displayAspect()), rule: { kind: "hold" } }));
  }, [edit, displayAspect]);

  const handleStandToggle = useCallback((on: boolean) => {
    edit((draft) => ({ draft: setStand(draft, on), rule: { kind: "layout" } }));
  }, [edit]);

  /** The chain between a pair: linked comes apart, split is made equal and linked again. */
  const handleChainToggle = useCallback((pair: LinkedPair) => {
    edit((draft) => ({ draft: toggleLink(draft, pair), rule: { kind: "hold" } }));
  }, [edit]);

  /** A typed total shared out over the lit edges (all four on a first visit). */
  const handleDistribute = useCallback((total: number) => {
    const t = Math.min(Math.floor(total), MAX_COUNT);
    if (!(t > 0)) return;
    edit((draft) => ({ draft: distribute(draft, t, displayAspect()), rule: { kind: "hold" } }));
    setFirstRun(false);
  }, [edit, displayAspect]);

  /** Skipping the total: one LED per edge, both pairs linked, for the numbers on the canvas to take from there. */
  const handleSkipTotal = useCallback(() => {
    edit(() => ({ draft: draftFromCounts({ top: 1, right: 1, bottom: 1, left: 1 }, 0), rule: { kind: "layout" } }));
    setFirstRun(false);
  }, [edit]);

  const handlePickLed = useCallback((led: LedRef) => {
    edit((draft, start) => ({ rule: { kind: "set", start: pickLed(draft, led, start) } }));
  }, [edit]);

  const handlePickCorner = useCallback((corner: Corner) => {
    edit((draft, start) => ({ rule: { kind: "set", start: pickCorner(draft, corner, start) } }));
  }, [edit]);

  const handlePickEnd = useCallback((end: "A" | "B") => {
    edit((draft, start) => ({ rule: { kind: "set", start: pickEnd(draft, end, start) } }));
  }, [edit]);

  /** A place picked from the first-LED list. */
  const handleSetStart = useCallback((start: StartPoint) => {
    edit(() => ({ rule: { kind: "set", start } }));
  }, [edit]);

  const handleNudge = useCallback((step: 1 | -1) => {
    edit((draft, start) => ({ rule: { kind: "set", start: nudge(draft, start, step) } }));
  }, [edit]);

  const handleDirectionChange = useCallback((direction: LedDirection) => {
    edit((draft, start) => ({ rule: { kind: "set", start: setDirection(draft, start, direction) } }));
  }, [edit]);

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
    // The page stays open after a save, and a running test keeps going on the saved layout.
    onSaved(savedState.current);
    setKeepUiFor(calibrationLayoutKey(savedState.baseline));
    setEditorState(savedState);
    setSavedOnce(true);
    setLastSavedAt(Date.now());
    dirtyRef.current = false;
    setIsSaving(false);
  }, [editorState, onSaved]);

  /** "İptal": back to the last saved layout, staying on the page. */
  const handleRevert = useCallback(() => {
    setEditorState((prev) => loadEditorConfig(prev, prev.baseline));
    setLayoutUi(layoutUiFrom(editorState.baseline));
    setValidationErrors(null);
    setSaveError(null);
  }, [editorState.baseline]);

  const handleKeepEditing = useCallback(() => {
    pendingLeaveRef.current = null;
    setEditorState((prev) => keepEditing(prev));
  }, []);

  const handleDiscard = useCallback(() => {
    const proceed = pendingLeaveRef.current;
    pendingLeaveRef.current = null;
    dirtyRef.current = false;
    setEditorState((prev) => discardEditorChanges(prev));
    setSaveError(null);
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
    firstRun,
    canSave: editorState.isDirty || !savedOnce,
    lastSavedAt,
    layoutUi,
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
    handleEdgeToggle,
    handleStandToggle,
    handleCountChange,
    handleChainToggle,
    handleDistribute,
    handleSkipTotal,
    handlePickLed,
    handlePickCorner,
    handlePickEnd,
    handleSetStart,
    handleNudge,
    handleDirectionChange,
    handleSave,
    handleRevert,
    handleKeepEditing,
    handleDiscard,
    handleOpenPreview,
  };
}
