import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useTranslation } from "react-i18next";

import { shellStore } from "@/features/persistence/shellStore";
import {
  openLedTwinOverlay,
  openLedControlPopup,
  showLedControlPopup,
} from "@/features/preview/previewApi";
import type { LedCalibrationConfig, LedDirection, LedStartAnchor } from "../model/contracts";
import { buildLedSequence } from "../model/indexMapping";
import { deriveDefaultCounts, resetToManual } from "../model/templates";
import {
  validateCalibrationConfig,
  type CalibrationValidationCode,
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
} from "../state/calibrationEditorState";
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
} from "../state/testPatternFlow";
import { createDisplayTargetState, type DisplayTargetSnapshot } from "../state/displayTargetState";
import { LedRoomCanvas } from "./LedRoomCanvas";
import {
  DISPLAY_OVERLAY_STATUS,
  type DisplayInfo,
  type OverlayPreviewPayload,
} from "@/shared/contracts/display";
import { LED_TEST_STATUS } from "@/shared/contracts/preview";
import { clamp } from "@/shared/lib/math";
import { useDialogFocus } from "@/shared/ui/useDialogFocus";

function reclaimFocus() {
  void getCurrentWindow().setFocus();
  setTimeout(() => void getCurrentWindow().setFocus(), 150);
}

interface CalibrationPageProps {
  initialConfig?: LedCalibrationConfig;
  onNavigateBack: () => void;
  onSaved: (config: LedCalibrationConfig) => void;
  /** Mirrors the choice into the mode runtime cache, the same way `onSaved` does
   *  for the layout. Persisting alone leaves the live capture on the old monitor. */
  onDisplayChange?: (displayId: string) => void;
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

type AnchorEdge = "top" | "right" | "bottom" | "left";
type AnchorEndpoint = "start" | "end" | "gap-right" | "gap-left";

function edgeOfAnchor(anchor: LedStartAnchor): AnchorEdge {
  if (anchor.startsWith("top")) return "top";
  if (anchor.startsWith("right")) return "right";
  if (anchor.startsWith("bottom")) return "bottom";
  return "left";
}

function endpointOfAnchor(anchor: LedStartAnchor): AnchorEndpoint {
  if (anchor === "bottom-gap-right") return "gap-right";
  if (anchor === "bottom-gap-left") return "gap-left";
  return anchor.endsWith("-end") ? "end" : "start";
}

function anchorFromEdgeEndpoint(edge: AnchorEdge, endpoint: AnchorEndpoint): LedStartAnchor {
  if (endpoint === "gap-right") return "bottom-gap-right";
  if (endpoint === "gap-left") return "bottom-gap-left";
  return `${edge}-${endpoint}` as LedStartAnchor;
}

/** Literal keys, never a template: the orphan ratchet scans source text, so an
 *  interpolated key reads as referenced nowhere. Typing it by the code union
 *  also turns a new validation code into a compile error, not a blank line. */
const VALIDATION_MESSAGE_KEYS = {
  COUNTS_REQUIRED: "calibration:page.validation.COUNTS_REQUIRED",
  SEGMENT_NEGATIVE: "calibration:page.validation.SEGMENT_NEGATIVE",
  TOTAL_MISMATCH: "calibration:page.validation.TOTAL_MISMATCH",
  BOTTOM_MISSING_NEGATIVE: "calibration:page.validation.BOTTOM_MISSING_NEGATIVE",
  BOTTOM_MISSING_EXCEEDS_BOTTOM: "calibration:page.validation.BOTTOM_MISSING_EXCEEDS_BOTTOM",
  NO_LEDS_CONFIGURED: "calibration:page.validation.NO_LEDS_CONFIGURED",
  // `satisfies`, not an annotation: `t()` needs the literal types, and this
  // still fails to compile if a code is added to the union without a string.
} as const satisfies Record<CalibrationValidationCode, string>;

export function CalibrationPage({ initialConfig, onNavigateBack, onSaved, onDisplayChange }: CalibrationPageProps) {
  const { t } = useTranslation();

  const [editorState, setEditorState] = useState<CalibrationEditorState>(() =>
    buildInitialEditorState(initialConfig),
  );
  const [isSaving, setIsSaving] = useState(false);

  // Escape means "keep editing" — the safe answer for a dialog whose other
  // option throws work away.
  const { containerRef: discardDialogRef, handleKeyDown: handleDiscardKeyDown } = useDialogFocus(
    editorState.confirmDiscard,
    { onClose: () => setEditorState((prev) => keepEditing(prev)) },
  );
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

  // Load displays on mount. Honour any persisted selection so the
  // capture source survives app restarts (v1.4 Platform GAP 2).
  useEffect(() => {
    let cancelled = false;
    Promise.all([listDisplays(), shellStore.load()])
      .then(([displays, shell]) => {
        if (cancelled) return;
        let newState = displayTargetRef.current.setDisplays(displays);
        const persisted = shell.selectedDisplayId;
        if (persisted && displays.some((candidate) => candidate.id === persisted)) {
          newState = displayTargetRef.current.selectDisplay(persisted);
        } else if (displays.length > 0 && !newState.selectedDisplayId) {
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
        const reason = error instanceof Error ? error.message : String(error);
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

  const handlePreviewToggle = useCallback(async () => {
    const shouldEnable = !testPattern.isEnabled;
    try {
      if (shouldEnable) {
        if (displayTarget.blocked) {
          const reason = displayTarget.blockedReason ?? t("calibration:overlay.blockedReasonUnknown");
          const code = displayTarget.blockedCode ?? DISPLAY_OVERLAY_STATUS.OPEN_FAILED;
          setTestPatternError(t("calibration:overlay.errors.testPatternBlocked", { code, reason }));
          return;
        }
        const switched = await displayTargetRef.current.switchActiveDisplay(undefined, overlayPreviewPayload);
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
      const reason = error instanceof Error ? error.message : String(error);
      setTestPatternError(t("calibration:overlay.errors.testPatternToggleFailed", { reason }));
      // Best-effort rollback: testPatternError above already tells the user what
      // failed, so a failing rollback must not overwrite it with a second message.
      // Logged at debug level so the swallow is still visible in the log sink.
      try {
        const s = await flowRef.current.toggle(false);
        setTestPattern(s);
      } catch (rollbackError) {
        console.debug(`[LumaSync] Test pattern rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
      }
      try {
        const c = await displayTargetRef.current.closeActiveDisplay();
        setDisplayTarget(c);
      } catch (rollbackError) {
        console.debug(`[LumaSync] Overlay close after failure did not complete: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
      }
    }
  }, [testPattern.isEnabled, displayTarget, overlayPreviewPayload, t]);

  const handleSelectDisplay = useCallback(async (display: DisplayInfo) => {
    const selected = displayTargetRef.current.selectDisplay(display.id);
    setDisplayTarget(selected);
    // Persist so the next set_lighting_mode call binds the ambilight
    // worker to the user's chosen capture source (v1.4 Platform GAP 2).
    void shellStore.save({ selectedDisplayId: display.id });
    // Synchronous, for the same reason `onSaved` is: shellStore only feeds the
    // next boot, so without this the live payload keeps the old monitor.
    onDisplayChange?.(display.id);

    // Auto-derive default counts only when the user hasn't customized yet
    // (fresh manual default → totalLeds === 0).
    if (editorState.current.totalLeds === 0) {
      const defaults = deriveDefaultCounts(display);
      setEditorState((prev) => updateEditorConfig(prev, { counts: defaults }));
    }

    if (!testPattern.isEnabled) return;
    try {
      const switched = await displayTargetRef.current.switchActiveDisplay(display.id, overlayPreviewPayload);
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
      const reason = error instanceof Error ? error.message : String(error);
      setTestPatternError(t("calibration:overlay.errors.displaySwitchFailed", { reason }));
    }
  }, [editorState, overlayPreviewPayload, testPattern.isEnabled, t, onDisplayChange]);

  // A3.7 — accept the absolute next value, not a delta. Stepper buttons
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

  // A3.7 — accept the absolute next value, not a delta. Same shape as
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

  const { counts, bottomMissing, startAnchor, direction, totalLeds } = editorState.current;
  const currentEdge = edgeOfAnchor(startAnchor);
  const currentEndpoint = endpointOfAnchor(startAnchor);
  const meterLength = (totalLeds / 60).toFixed(1);
  const powerWatts = (totalLeds * 0.06).toFixed(1); // ~0.06W per LED at medium brightness

  // v1.6 — launch the LED preview surface (click-through digital-twin
  // overlay + interactive control popup) straight from LED Setup. The
  // preview API never throws; the try/catch guards the shellStore write.
  const handleOpenPreview = useCallback(async () => {
    try {
      // Without an explicit id Rust falls back to the primary display, which
      // strands the overlay on the wrong monitor for a non-primary selection.
      await openLedTwinOverlay({
        scope: "test",
        displayId: displayTargetRef.current.getSnapshot().selectedDisplayId ?? undefined,
      });
      await openLedControlPopup();
      await showLedControlPopup();
      await shellStore.save({ ledPreviewPopupVisible: true, ledTwinEnabledTest: true });
    } catch (err) {
      console.error("[LumaSync] open LED preview from setup failed:", err);
    }
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Error strip */}
      {(testPatternError || displayTarget.blocked || (validationErrors && validationErrors.length > 0)) && (
        <div
          role="alert"
          aria-live="polite"
          className="shrink-0 mx-4 mt-3 flex flex-col gap-1 rounded-lg border border-[var(--lm-red)]/25 bg-[var(--lm-red)]/10 px-3.5 py-2.5"
        >
          {displayTarget.blocked && (
            <ErrorLine text={t("calibration:overlay.blockedReason", {
              code: displayTarget.blockedCode ?? DISPLAY_OVERLAY_STATUS.OPEN_FAILED,
              reason: displayTarget.blockedReason ?? t("calibration:overlay.blockedReasonUnknown"),
            })} />
          )}
          {testPatternError && <ErrorLine text={testPatternError} />}
          {validationErrors?.map((error) => (
            <ErrorLine
              key={`${error.code}:${error.field}`}
              text={t(VALIDATION_MESSAGE_KEYS[error.code], { field: error.field })}
            />
          ))}
        </div>
      )}

      {/* Main: stage + dock */}
      <div className="flex min-h-0 flex-1">
        {/* Stage */}
        <div className="flex min-w-0 flex-1 flex-col">
          {/* Stage header */}
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-1.5 border-b border-[var(--lm-line)] px-6 py-2.5">
            <div className="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
              <span className="[font-family:var(--lm-mono)] text-[10px] uppercase tracking-[0.16em] text-[var(--lm-amber)]">
                {t("calibration:page.totalStrip")}
              </span>
              <span className="[font-family:var(--lm-mono)] text-lg font-semibold leading-none text-[var(--lm-ink)]">
                {totalLeds}
              </span>
              <span className="[font-family:var(--lm-mono)] text-[10px] uppercase tracking-[0.1em] text-[var(--lm-ink-dim)]">
                {t("calibration:page.ledsUnit")}
              </span>
              <span aria-hidden className="[font-family:var(--lm-mono)] text-[10px] text-[var(--lm-ink-faint)]">·</span>
              <span className="whitespace-nowrap [font-family:var(--lm-mono)] text-[10px] text-[var(--lm-ink-dim)]">
                {t("calibration:page.lengthAndPower", { meters: meterLength, watts: powerWatts })}
              </span>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={() => void handleOpenPreview()}
                title={t("preview:entry.ledSetupHint")}
                className="inline-flex items-center gap-1.5 rounded-md border border-[var(--lm-amber)]/40 bg-[var(--lm-amber)]/10 px-2.5 py-1.5 text-xs font-medium text-[var(--lm-amber)] transition-colors hover:bg-[var(--lm-amber)]/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--lm-amber)]/60"
              >
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <rect x="3" y="5" width="18" height="12" rx="1.5" />
                  <circle cx="7" cy="11" r="1.2" fill="currentColor" stroke="none" />
                  <circle cx="12" cy="11" r="1.2" fill="currentColor" stroke="none" />
                  <circle cx="17" cy="11" r="1.2" fill="currentColor" stroke="none" />
                </svg>
                {t("preview:entry.ledSetupButton")}
              </button>
              <button
                type="button"
                onClick={handleReset}
                className="inline-flex items-center gap-1.5 rounded-md border border-[var(--lm-line-2)] bg-[var(--lm-panel)] px-2.5 py-1.5 text-xs font-medium text-[var(--lm-ink)] transition-colors hover:bg-[var(--lm-panel-2)]"
              >
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <path d="M3 12l3-3 4 4 8-8 3 3" />
                  <path d="M21 6v6h-6" />
                </svg>
                {t("calibration:page.reset")}
              </button>
              <button
                type="button"
                disabled={displayTarget.isSwitching || displayTarget.displays.length === 0}
                onClick={() => void handlePreviewToggle()}
                className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                  testPattern.isEnabled
                    ? "bg-[var(--lm-amber)] text-[var(--lm-bg)] hover:bg-[var(--lm-amber)]"
                    : "border border-[var(--lm-line-2)] bg-[var(--lm-panel)] text-[var(--lm-ink)] hover:bg-[var(--lm-panel-2)]"
                }`}
              >
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <path d="M12 2v4M12 18v4M4.9 4.9l2.8 2.8M16.3 16.3l2.8 2.8M2 12h4M18 12h4M4.9 19.1l2.8-2.8M16.3 7.7l2.8-2.8" />
                </svg>
                {testPattern.isEnabled
                  ? t("calibration:page.stopTestPattern")
                  : t("calibration:page.runTestPattern")}
              </button>
            </div>
          </div>

          {/* Canvas */}
          <div className="relative min-h-0 flex-1 overflow-hidden bg-black/30">
            <LedRoomCanvas config={editorState.current} />
            {testPattern.isEnabled && (
              <div className={`absolute top-3 left-3 flex items-center gap-1.5 rounded-md px-2 py-1 [font-family:var(--lm-mono)] text-[10px] uppercase tracking-[0.12em] ${
                testPattern.mode === "preview-only"
                  ? "bg-[var(--lm-amber)]/15 text-[var(--lm-amber)]"
                  : "bg-[var(--lm-green)]/15 text-[var(--lm-green)]"
              }`}>
                <span className={`h-1.5 w-1.5 rounded-full ${
                  testPattern.mode === "preview-only" ? "bg-[var(--lm-amber)]" : "animate-pulse bg-[var(--lm-green)]"
                }`} />
                {testPattern.mode === "preview-only"
                  ? t("calibration:overlay.previewOnly")
                  : t("calibration:overlay.outputActive")}
              </div>
            )}
          </div>

          {/* Edge summary */}
          <div className="grid shrink-0 grid-cols-4 border-t border-[var(--lm-line)]">
            <EdgeSummary label={t("calibration:page.edgeTop")} value={counts.top} />
            <EdgeSummary label={t("calibration:page.edgeRight")} value={counts.right} />
            <EdgeSummary label={t("calibration:page.edgeBottom")} value={counts.bottom} />
            <EdgeSummary label={t("calibration:page.edgeLeft")} value={counts.left} />
          </div>
        </div>

        {/* Dock */}
        <div className="flex w-[268px] shrink-0 flex-col border-l border-[var(--lm-line)] bg-black/30">
          <div className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto p-4">
          <DockSection title={t("calibration:page.dockCaptureSource")}>
            <div className="flex flex-col gap-1.5">
              {displayTarget.displays.length === 0 ? (
                <div className="rounded-md border border-dashed border-[var(--lm-line-2)] px-3 py-2 text-xs text-[var(--lm-ink-dim)]">
                  {t("calibration:overlay.noDisplays")}
                </div>
              ) : (
                displayTarget.displays.map((display) => {
                  const isSelected = display.id === displayTarget.selectedDisplayId;
                  return (
                    <button
                      key={display.id}
                      type="button"
                      disabled={displayTarget.isSwitching}
                      onClick={() => void handleSelectDisplay(display)}
                      className={`flex items-center gap-2 rounded-md border px-2.5 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                        isSelected
                          ? "border-[var(--lm-amber)]/40 bg-[var(--lm-amber)]/10 text-[var(--lm-amber)]"
                          : "border-[var(--lm-line-2)] bg-[var(--lm-panel)] hover:border-[var(--lm-line-2)]"
                      }`}
                    >
                      <div className={`h-4 w-6 shrink-0 rounded-sm border ${isSelected ? "border-[var(--lm-amber)]" : "border-[var(--lm-line-2)]"}`}>
                        {isSelected && <div className="h-full w-full rounded-sm bg-[var(--lm-amber)]/20" />}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate [font-family:var(--lm-mono)] text-[10px] uppercase tracking-[0.1em] font-medium">
                          {display.label}
                        </div>
                        <div className="truncate [font-family:var(--lm-mono)] text-[9px] text-[var(--lm-ink-dim)]">
                          {display.width} × {display.height}
                        </div>
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </DockSection>

          <DockSection title={t("calibration:page.dockLedCountPerEdge")}>
            <div className="grid grid-cols-2 gap-1.5">
              <CountStepper label={t("calibration:page.edgeTop")} value={counts.top} onChange={(v) => handleCountChange("top", v)} />
              <CountStepper label={t("calibration:page.edgeRight")} value={counts.right} onChange={(v) => handleCountChange("right", v)} />
              <CountStepper label={t("calibration:page.edgeBottom")} value={counts.bottom} onChange={(v) => handleCountChange("bottom", v)} />
              <CountStepper label={t("calibration:page.edgeLeft")} value={counts.left} onChange={(v) => handleCountChange("left", v)} />
            </div>
          </DockSection>

          {counts.bottom > 0 && (
            <DockSection title={t("calibration:page.dockStandGap")}>
              <StandGapStepper
                value={bottomMissing}
                max={counts.bottom}
                onChange={handleBottomMissingChange}
              />
            </DockSection>
          )}

          <DockSection title={t("calibration:page.dockStartAnchor")}>
            <div className="grid grid-cols-4 gap-1">
              <EdgeTab edge="top" label={t("calibration:page.startEdgeTop")} active={currentEdge === "top"} disabled={counts.top === 0} onClick={handleEdgeChange} />
              <EdgeTab edge="right" label={t("calibration:page.startEdgeRight")} active={currentEdge === "right"} disabled={counts.right === 0} onClick={handleEdgeChange} />
              <EdgeTab edge="bottom" label={t("calibration:page.startEdgeBottom")} active={currentEdge === "bottom"} disabled={counts.bottom === 0} onClick={handleEdgeChange} />
              <EdgeTab edge="left" label={t("calibration:page.startEdgeLeft")} active={currentEdge === "left"} disabled={counts.left === 0} onClick={handleEdgeChange} />
            </div>
            <div className="mt-2 flex flex-wrap gap-1">
              <EndpointButton endpoint="start" label={t("calibration:page.anchorStart")} active={currentEndpoint === "start"} onClick={handleEndpointChange} />
              {currentEdge === "bottom" && bottomMissing > 0 && (
                <>
                  <EndpointButton endpoint="gap-right" label={t("calibration:page.anchorGapRight")} active={currentEndpoint === "gap-right"} onClick={handleEndpointChange} />
                  <EndpointButton endpoint="gap-left" label={t("calibration:page.anchorGapLeft")} active={currentEndpoint === "gap-left"} onClick={handleEndpointChange} />
                </>
              )}
              <EndpointButton endpoint="end" label={t("calibration:page.anchorEnd")} active={currentEndpoint === "end"} onClick={handleEndpointChange} />
            </div>
          </DockSection>

          <DockSection title={t("calibration:page.dockDirection")}>
            <div className="grid grid-cols-2 gap-1">
              <DirectionButton direction="cw" label={t("calibration:page.dockDirectionCw")} active={direction === "cw"} onClick={handleDirectionChange} />
              <DirectionButton direction="ccw" label={t("calibration:page.dockDirectionCcw")} active={direction === "ccw"} onClick={handleDirectionChange} />
            </div>
          </DockSection>

          </div>

          {/* Sticky Save/Cancel footer */}
          <div className="flex shrink-0 items-center gap-2 border-t border-[var(--lm-line)] bg-black/30 px-4 py-3">
            <button
              type="button"
              onClick={handleClose}
              className="flex-1 rounded-md border border-[var(--lm-line-2)] px-3 py-1.5 text-xs font-medium text-[var(--lm-ink)] transition-colors hover:bg-[var(--lm-panel-2)]"
            >
              {t("calibration:overlay.cancel")}
            </button>
            <button
              type="button"
              disabled={isSaving}
              aria-busy={isSaving}
              onClick={() => void handleSave()}
              className="flex-1 rounded-md bg-[var(--lm-amber)] px-3 py-1.5 text-xs font-semibold text-[var(--lm-bg)] transition-colors hover:bg-[var(--lm-amber)] disabled:opacity-50"
            >
              {isSaving ? t("calibration:overlay.saving") : t("calibration:overlay.save")}
            </button>
          </div>
        </div>
      </div>

      {/* Discard confirmation */}
      {editorState.confirmDiscard && (
        <div
          ref={discardDialogRef}
          onKeyDown={handleDiscardKeyDown}
          tabIndex={-1}
          role="dialog"
          aria-modal="true"
          aria-labelledby="lm-discard-title"
          className="lm-modal-scrim"
        >
          <div className="w-full max-w-md rounded-xl border border-[var(--lm-line-2)] bg-[var(--lm-panel)] p-5 shadow-xl">
            <h3 id="lm-discard-title" className="text-base font-semibold text-[var(--lm-ink)]">
              {t("calibration:overlay.unsavedTitle")}
            </h3>
            <p className="mt-2 text-sm text-[var(--lm-ink)]">
              {t("calibration:overlay.unsavedDescription")}
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setEditorState((prev) => keepEditing(prev))}
                className="rounded-md border border-[var(--lm-line-2)] px-3 py-1.5 text-sm font-medium text-[var(--lm-ink)]"
              >
                {t("calibration:overlay.keepEditing")}
              </button>
              <button
                type="button"
                onClick={() => {
                  setEditorState((prev) => discardEditorChanges(prev));
                  void flowRef.current.dispose();
                  setTestPattern(flowRef.current.getSnapshot());
                  onNavigateBack();
                }}
                className="rounded-md bg-[var(--lm-red)] px-3 py-1.5 text-sm font-semibold text-white"
              >
                {t("calibration:overlay.discard")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function DockSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-2 [font-family:var(--lm-mono)] text-[9.5px] uppercase tracking-[0.18em] text-[var(--lm-ink-dim)]">
        <span className="h-px w-2.5 bg-[var(--lm-line-2)]" />
        {title}
      </div>
      {children}
    </div>
  );
}

function EdgeSummary({ label, value }: { label: string; value: number }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-baseline gap-1.5 px-4 py-2">
      <span className="[font-family:var(--lm-mono)] text-[9px] uppercase tracking-[0.14em] text-[var(--lm-ink-dim)]">{label}</span>
      <span className="[font-family:var(--lm-mono)] text-sm font-medium text-[var(--lm-ink)]">{value}</span>
      <span className="[font-family:var(--lm-mono)] text-[9px] uppercase tracking-[0.1em] text-[var(--lm-ink-faint)]">{t("calibration:page.ledUnit")}</span>
    </div>
  );
}

// A3.7 — number stepper with always-editable keyboard input.
// `value` is the committed integer; `draft` mirrors the user's
// in-flight typing so the field can hold an empty / partial value
// without bouncing back to `value` mid-keystroke. ENTER and blur
// commit; ESC reverts; +/- buttons call onChange(value ± 1) so the
// stepper preserves the original delta affordance via the unified
// absolute-value API. type="text" + inputMode="numeric" gives the
// mobile numeric keyboard without rendering the native spinner that
// would visually conflict with our +/- column.
function CountStepper({ label, value, onChange }: { label: string; value: number; onChange: (nextValue: number) => void }) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<string>(String(value));
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Sync the draft when the parent value changes from the outside
  // (reset button, template apply, +/- click) so we never display a
  // stale number after a programmatic update.
  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  const commit = useCallback(() => {
    const parsed = Number.parseInt(draft, 10);
    if (!Number.isFinite(parsed)) {
      setDraft(String(value));
      return;
    }
    if (parsed === value) {
      // No semantic change — re-sync draft to canonical (e.g. user
      // typed "0007" → committed value would be 7, draft stays "0007").
      setDraft(String(value));
      return;
    }
    onChange(parsed);
  }, [draft, value, onChange]);

  return (
    <div className="rounded-md border border-[var(--lm-line-2)] bg-[var(--lm-panel)] px-2 py-1.5">
      <div className="[font-family:var(--lm-mono)] text-[9px] uppercase tracking-[0.14em] text-[var(--lm-ink-dim)]">{label}</div>
      <div className="mt-1 flex items-center gap-1.5">
        <input
          ref={inputRef}
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          value={draft}
          onChange={(e) => setDraft(e.target.value.replace(/[^0-9]/g, ""))}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              commit();
              inputRef.current?.blur();
            } else if (e.key === "Escape") {
              setDraft(String(value));
              inputRef.current?.blur();
            }
          }}
          aria-label={t("calibration:page.aria.countInput", { label })}
          className="min-w-0 flex-1 bg-transparent border-0 p-0 [font-family:var(--lm-mono)] text-base font-medium text-[var(--lm-ink)] outline-none focus:underline focus:decoration-amber-400 focus:underline-offset-4"
        />
        <div className="flex flex-col gap-0.5">
          <button
            type="button"
            onClick={() => onChange(value + 1)}
            aria-label={t("calibration:page.aria.countIncrease", { label })}
            className="flex h-4 w-5 items-center justify-center rounded border border-[var(--lm-line-2)] text-[10px] leading-none text-[var(--lm-ink-dim)] transition-colors hover:border-[var(--lm-amber)] hover:text-[var(--lm-amber)]"
          >
            +
          </button>
          <button
            type="button"
            onClick={() => onChange(value - 1)}
            aria-label={t("calibration:page.aria.countDecrease", { label })}
            className="flex h-4 w-5 items-center justify-center rounded border border-[var(--lm-line-2)] text-[10px] leading-none text-[var(--lm-ink-dim)] transition-colors hover:border-[var(--lm-amber)] hover:text-[var(--lm-amber)]"
          >
            −
          </button>
        </div>
      </div>
    </div>
  );
}

function EdgeTab({ edge, label, active, disabled, onClick }: { edge: AnchorEdge; label: string; active: boolean; disabled: boolean; onClick: (e: AnchorEdge) => void }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onClick(edge)}
      aria-pressed={active}
      className={`rounded-md border px-1.5 py-1.5 [font-family:var(--lm-mono)] text-[9px] uppercase tracking-[0.1em] transition-colors disabled:cursor-not-allowed disabled:opacity-35 ${
        active
          ? "border-[var(--lm-amber)]/40 bg-[var(--lm-amber)]/10 text-[var(--lm-amber)]"
          : "border-[var(--lm-line-2)] bg-[var(--lm-panel)] text-[var(--lm-ink-dim)] hover:border-[var(--lm-line-2)]"
      }`}
    >
      {label}
    </button>
  );
}

function EndpointButton({ endpoint, label, active, onClick }: { endpoint: AnchorEndpoint; label: string; active: boolean; onClick: (e: AnchorEndpoint) => void }) {
  return (
    <button
      type="button"
      onClick={() => onClick(endpoint)}
      aria-pressed={active}
      className={`flex-1 rounded-md border px-2 py-1.5 [font-family:var(--lm-mono)] text-[9px] uppercase tracking-[0.1em] transition-colors ${
        active
          ? "border-[var(--lm-amber)]/40 bg-[var(--lm-amber)]/10 text-[var(--lm-amber)]"
          : "border-[var(--lm-line-2)] bg-[var(--lm-panel)] text-[var(--lm-ink-dim)] hover:border-[var(--lm-line-2)]"
      }`}
    >
      {label}
    </button>
  );
}

function DirectionButton({ direction, label, active, onClick }: { direction: LedDirection; label: string; active: boolean; onClick: (d: LedDirection) => void }) {
  return (
    <button
      type="button"
      onClick={() => onClick(direction)}
      aria-pressed={active}
      className={`rounded-md border px-2 py-1.5 [font-family:var(--lm-mono)] text-[10px] tracking-[0.1em] transition-colors ${
        active
          ? "border-[var(--lm-amber)]/40 bg-[var(--lm-amber)]/10 text-[var(--lm-amber)]"
          : "border-[var(--lm-line-2)] bg-[var(--lm-panel)] text-[var(--lm-ink-dim)] hover:border-[var(--lm-line-2)]"
      }`}
    >
      {label}
    </button>
  );
}

// A3.7 — same keyboard-input pattern as CountStepper, with the
// `max` cap (counts.bottom) preserved on commit so an out-of-range
// keystroke still clamps. The label slot keeps the small "LED"
// header + the "/ {max}" sibling so the user always sees the
// available headroom while typing.
function StandGapStepper({ value, max, onChange }: { value: number; max: number; onChange: (nextValue: number) => void }) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<string>(String(value));
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  const commit = useCallback(() => {
    const parsed = Number.parseInt(draft, 10);
    if (!Number.isFinite(parsed)) {
      setDraft(String(value));
      return;
    }
    const clamped = clamp(parsed, 0, max);
    if (clamped === value) {
      setDraft(String(value));
      return;
    }
    onChange(clamped);
  }, [draft, value, max, onChange]);

  return (
    <div className="flex items-center gap-2 rounded-md border border-[var(--lm-line-2)] bg-[var(--lm-panel)] px-2.5 py-1.5">
      <div className="min-w-0 flex-1">
        <div className="[font-family:var(--lm-mono)] text-[9px] uppercase tracking-[0.14em] text-[var(--lm-ink-dim)]">
          LED
        </div>
        <input
          ref={inputRef}
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          value={draft}
          onChange={(e) => setDraft(e.target.value.replace(/[^0-9]/g, ""))}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              commit();
              inputRef.current?.blur();
            } else if (e.key === "Escape") {
              setDraft(String(value));
              inputRef.current?.blur();
            }
          }}
          aria-label={t("calibration:page.aria.gapInput")}
          className="w-full bg-transparent border-0 p-0 [font-family:var(--lm-mono)] text-base font-medium text-[var(--lm-ink)] outline-none focus:underline focus:decoration-amber-400 focus:underline-offset-4"
        />
      </div>
      <div className="[font-family:var(--lm-mono)] text-[9px] text-[var(--lm-ink-faint)]">/ {max}</div>
      <div className="flex flex-col gap-0.5">
        <button
          type="button"
          disabled={value >= max}
          onClick={() => onChange(value + 1)}
          aria-label={t("calibration:page.aria.gapIncrease")}
          className="flex h-4 w-5 items-center justify-center rounded border border-[var(--lm-line-2)] text-[10px] leading-none text-[var(--lm-ink-dim)] transition-colors hover:border-[var(--lm-amber)] hover:text-[var(--lm-amber)] disabled:cursor-not-allowed disabled:opacity-35"
        >
          +
        </button>
        <button
          type="button"
          disabled={value <= 0}
          onClick={() => onChange(value - 1)}
          aria-label={t("calibration:page.aria.gapDecrease")}
          className="flex h-4 w-5 items-center justify-center rounded border border-[var(--lm-line-2)] text-[10px] leading-none text-[var(--lm-ink-dim)] transition-colors hover:border-[var(--lm-amber)] hover:text-[var(--lm-amber)] disabled:cursor-not-allowed disabled:opacity-35"
        >
          −
        </button>
      </div>
    </div>
  );
}

function ErrorLine({ text }: { text: string }) {
  return (
    <p className="flex items-start gap-2 text-xs text-[var(--lm-red)]">
      <svg className="mt-0.5 h-3.5 w-3.5 shrink-0" viewBox="0 0 16 16" fill="none">
        <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.4" />
        <path d="M8 5v3.5M8 10.5v.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
      <span>{text}</span>
    </p>
  );
}
