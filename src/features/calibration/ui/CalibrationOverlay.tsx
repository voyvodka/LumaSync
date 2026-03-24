import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { shellStore } from "../../persistence/shellStore";
import type { LedCalibrationConfig } from "../model/contracts";
import type { LedSegmentKey } from "../model/contracts";
import { buildLedSequence, resolveLedSequenceItem } from "../model/indexMapping";
import { applyTemplate, resetToManual } from "../model/templates";
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
} from "../state/calibrationEditorState";
import {
  closeDisplayOverlay,
  listDisplays,
  openDisplayOverlay,
  updateDisplayOverlayPreview,
} from "../calibrationApi";
import { createDefaultTestPatternFlow, type TestPatternSnapshot } from "../state/testPatternFlow";
import { createDisplayTargetState, type DisplayTargetSnapshot } from "../state/displayTargetState";
import type { CalibrationOverlayStep } from "../state/entryFlow";
import { CalibrationEditorCanvas } from "./CalibrationEditorCanvas";
import { CalibrationTemplateStep } from "./CalibrationTemplateStep";
import { getSerialConnectionStatus } from "../../device/deviceConnectionApi";
import type { OverlayPreviewPayload } from "../../../shared/contracts/display";

interface CalibrationOverlayProps {
  open: boolean;
  initialStep: CalibrationOverlayStep;
  initialConfig?: LedCalibrationConfig;
  onClose: () => void;
  onSaved: (config: LedCalibrationConfig) => void;
}

function buildInitialEditorState(initialConfig?: LedCalibrationConfig): CalibrationEditorState {
  return createCalibrationEditorState(initialConfig ?? resetToManual());
}

function areSnapshotsEqual(left: TestPatternSnapshot, right: TestPatternSnapshot) {
  return (
    left.isEnabled === right.isEnabled &&
    left.mode === right.mode &&
    left.markerIndex === right.markerIndex &&
    left.totalLeds === right.totalLeds &&
    left.isBlockingSave === right.isBlockingSave
  );
}

function buildSegmentOrder(sequence: ReturnType<typeof buildLedSequence>) {
  const seen = new Set<LedSegmentKey>();
  const order: LedSegmentKey[] = [];

  for (let markerIndex = 0; markerIndex < sequence.length; markerIndex += 1) {
    const item = resolveLedSequenceItem(sequence, markerIndex);
    if (!item) {
      continue;
    }

    if (seen.has(item.segment)) {
      continue;
    }
    seen.add(item.segment);
    order.push(item.segment);
  }

  return order;
}

function buildOverlayPreviewPayload(
  config: LedCalibrationConfig,
  sequence: ReturnType<typeof buildLedSequence>,
): OverlayPreviewPayload {
  return {
    counts: {
      top: config.counts.top,
      right: config.counts.right,
      bottom: config.counts.bottom,
      left: config.counts.left,
    },
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

function resolveAnchorForBottomMissing(currentAnchor: LedCalibrationConfig["startAnchor"], nextBottomMissing: number) {
  if (nextBottomMissing > 0) {
    return currentAnchor;
  }

  if (currentAnchor === "bottom-gap-right") {
    return "bottom-start";
  }

  if (currentAnchor === "bottom-gap-left") {
    return "bottom-end";
  }

  return currentAnchor;
}

export function CalibrationOverlay({
  open,
  initialStep,
  initialConfig,
  onClose,
  onSaved,
}: CalibrationOverlayProps) {
  const { t } = useTranslation("common");
  const [activeStep, setActiveStep] = useState<CalibrationOverlayStep>(initialStep);
  const [editorState, setEditorState] = useState<CalibrationEditorState>(() =>
    buildInitialEditorState(initialConfig),
  );
  const [isSaving, setIsSaving] = useState(false);
  const flowRef = useRef(
    createDefaultTestPatternFlow(async () => {
      const status = await getSerialConnectionStatus();
      return { connected: status.connected };
    }, initialConfig),
  );
  const [testPattern, setTestPattern] = useState<TestPatternSnapshot>(flowRef.current.getSnapshot());
  const displayTargetRef = useRef(
    createDisplayTargetState({
      openDisplayOverlay,
      closeDisplayOverlay,
    }),
  );
  const [displayTarget, setDisplayTarget] = useState<DisplayTargetSnapshot>(
    displayTargetRef.current.getSnapshot(),
  );
  const [validationErrors, setValidationErrors] = useState<CalibrationValidationError[] | null>(null);
  const [testPatternError, setTestPatternError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    setActiveStep(initialStep);
    setEditorState(buildInitialEditorState(initialConfig));
    setValidationErrors(null);
    setTestPatternError(null);
    flowRef.current.setTotalLeds((initialConfig ?? resetToManual()).totalLeds);
    setTestPattern(flowRef.current.getSnapshot());
    displayTargetRef.current.clearBlockedState();
    setDisplayTarget(displayTargetRef.current.getSnapshot());
  }, [open, initialStep, initialConfig]);

  useEffect(() => {
    if (!open) {
      return;
    }

    let cancelled = false;
    void listDisplays()
      .then((displays) => {
        if (cancelled) {
          return;
        }

        setDisplayTarget(displayTargetRef.current.setDisplays(displays));
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }

        const reason = error instanceof Error ? error.message : String(error);
        console.warn(`[LumaSync] Display list unavailable for overlay: ${reason}`);

        setDisplayTarget(displayTargetRef.current.setDisplays([]));
      });

    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    flowRef.current.setConfig(editorState.current);
    flowRef.current.setTotalLeds(editorState.current.totalLeds);
    setTestPattern(flowRef.current.getSnapshot());
  }, [editorState.current]);

  useEffect(() => {
    if (!open || !testPattern.isEnabled) {
      return;
    }

    let frameId: number | null = null;
    const syncSnapshot = () => {
      const latest = flowRef.current.getSnapshot();
      setTestPattern((prev) => (areSnapshotsEqual(prev, latest) ? prev : latest));

      if (latest.isEnabled) {
        frameId = window.requestAnimationFrame(syncSnapshot);
      }
    };

    frameId = window.requestAnimationFrame(syncSnapshot);

    return () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
    };
  }, [open, testPattern.isEnabled]);

  useEffect(() => {
    if (open) {
      return;
    }

    void flowRef.current.dispose().then(() => {
      void displayTargetRef.current.closeActiveDisplay().then((nextDisplayTarget) => {
        setDisplayTarget(nextDisplayTarget);
      });
      setTestPattern(flowRef.current.getSnapshot());
    });
  }, [open]);

  useEffect(() => {
    return () => {
      void flowRef.current.dispose();
    };
  }, []);

  const sequence = useMemo(() => buildLedSequence(editorState.current), [editorState.current]);
  const markerItem = useMemo(
    () => resolveLedSequenceItem(sequence, testPattern.markerIndex),
    [sequence, testPattern.markerIndex],
  );
  const markerSegment = markerItem?.segment ?? sequence[0]?.segment ?? "top";
  const segmentOrder = useMemo(() => buildSegmentOrder(sequence), [sequence]);
  const overlayPreviewPayload = useMemo(
    () => buildOverlayPreviewPayload(editorState.current, sequence),
    [editorState.current, sequence],
  );

  useEffect(() => {
    if (!open || !testPattern.isEnabled || !displayTarget.activeDisplayId || displayTarget.blocked) {
      return;
    }

    void updateDisplayOverlayPreview(overlayPreviewPayload).then((result) => {
      if (!result.ok) {
        const reason = result.reason ?? result.message;
        console.warn(`[LumaSync] Overlay preview sync skipped (${result.code}): ${reason}`);
      }
    });
  }, [open, testPattern.isEnabled, displayTarget.activeDisplayId, displayTarget.blocked, overlayPreviewPayload]);

  const shell = useMemo(() => {
    if (!open) {
      return null;
    }

    return (
      <div className="fixed inset-0 z-50 flex min-h-screen w-full flex-col bg-slate-900/40 p-4 backdrop-blur-sm sm:p-8">
        <div className="mb-4 flex items-center justify-between rounded-xl border border-white/20 bg-black/30 px-4 py-2 text-white">
          <p className="text-sm font-medium">{t("calibration.overlay.title")}</p>
          <button
            type="button"
            onClick={() => {
              const closeState = requestEditorClose(editorState);
              setEditorState(closeState);
              if (closeState.shouldClose) {
                void flowRef.current.dispose();
                setTestPattern(flowRef.current.getSnapshot());
                onClose();
              }
            }}
            className="rounded-md border border-white/30 px-3 py-1 text-xs font-semibold hover:bg-white/10"
          >
            {t("calibration.overlay.close")}
          </button>
        </div>

        <div className="flex-1 overflow-auto overscroll-contain">
          {activeStep === "template" ? (
            <CalibrationTemplateStep
              selectedTemplateId={editorState.current.templateId}
              onSelectTemplate={(templateId) => {
                const config = applyTemplate(templateId);
                setEditorState((prev) => loadEditorConfig(prev, config));
                setActiveStep("editor");
              }}
            />
          ) : (
            <CalibrationEditorCanvas
              config={editorState.current}
              isDirty={editorState.isDirty}
              onCountChange={(segment, value) => {
                setEditorState((prev) =>
                  updateEditorConfig(prev, {
                    counts: {
                      [segment]: Number.isFinite(value) ? Math.max(0, value) : 0,
                    },
                  }),
                );
                setValidationErrors(null);
              }}
              onStartAnchorChange={(startAnchor) => {
                setEditorState((prev) => updateEditorConfig(prev, { startAnchor }));
                setValidationErrors(null);
              }}
              onDirectionChange={(direction) => {
                setEditorState((prev) => updateEditorConfig(prev, { direction }));
                setValidationErrors(null);
              }}
              onBottomMissingChange={(count) => {
                setEditorState((prev) => {
                  const startAnchor = resolveAnchorForBottomMissing(prev.current.startAnchor, count);
                  return updateEditorConfig(prev, {
                    bottomMissing: count,
                    startAnchor,
                  });
                });
                setValidationErrors(null);
              }}
              onCornerOwnershipChange={(cornerOwnership) => {
                setEditorState((prev) => updateEditorConfig(prev, { cornerOwnership }));
                setValidationErrors(null);
              }}
              onVisualPresetChange={(visualPreset) => {
                setEditorState((prev) => updateEditorConfig(prev, { visualPreset }));
                setValidationErrors(null);
              }}
              onResetTemplate={() => {
                setActiveStep("template");
              }}
            />
          )}
        </div>

        {/* Error / validation strip */}
        {(testPatternError || displayTarget.blocked || (validationErrors && validationErrors.length > 0)) && (
          <div className="mt-3 flex flex-col gap-1 rounded-lg border border-rose-500/25 bg-rose-950/60 px-3.5 py-2.5">
            {displayTarget.blocked && (
              <p className="flex items-start gap-2 text-xs text-rose-300">
                <svg className="mt-0.5 h-3.5 w-3.5 shrink-0" viewBox="0 0 16 16" fill="none">
                  <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.4" />
                  <path d="M8 5v3.5M8 10.5v.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                </svg>
                <span>
                  {t("calibration.overlay.blockedReason", {
                    code: displayTarget.blockedCode ?? "OVERLAY_OPEN_FAILED",
                    reason: displayTarget.blockedReason ?? t("calibration.overlay.blockedReasonUnknown"),
                  })}
                </span>
              </p>
            )}
            {testPatternError && (
              <p className="flex items-start gap-2 text-xs text-rose-300">
                <svg className="mt-0.5 h-3.5 w-3.5 shrink-0" viewBox="0 0 16 16" fill="none">
                  <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.4" />
                  <path d="M8 5v3.5M8 10.5v.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                </svg>
                <span>{testPatternError}</span>
              </p>
            )}
            {validationErrors && validationErrors.length > 0 &&
              validationErrors.map((error) => (
                <p key={`${error.code}:${error.field}`} className="flex items-start gap-2 text-xs text-rose-300">
                  <svg className="mt-0.5 h-3.5 w-3.5 shrink-0" viewBox="0 0 16 16" fill="none">
                    <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.4" />
                    <path d="M8 5v3.5M8 10.5v.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                  </svg>
                  <span>{error.code}: {error.field}</span>
                </p>
              ))}
          </div>
        )}

        {/* Main action bar */}
        <div className="mt-3 flex items-center gap-3 rounded-xl border border-white/12 bg-black/40 px-4 py-3">
          {/* Left: preview controls */}
          <div className="flex min-w-0 flex-1 items-center gap-3 overflow-hidden">
            {/* Toggle switch */}
            <div className="flex shrink-0 items-center gap-2.5">
              <button
                type="button"
                role="switch"
                aria-checked={testPattern.isEnabled}
                disabled={displayTarget.isSwitching}
                onClick={async () => {
                  const shouldEnable = !testPattern.isEnabled;
                  try {
                    if (shouldEnable) {
                      if (displayTarget.blocked) {
                        const reason = displayTarget.blockedReason ?? t("calibration.overlay.blockedReasonUnknown");
                        const code = displayTarget.blockedCode ?? "OVERLAY_OPEN_FAILED";
                        console.warn(`[LumaSync] Test pattern blocked (${code}): ${reason}`);
                        setTestPatternError(t("calibration.overlay.errors.testPatternBlocked", { code, reason }));
                        return;
                      }
                      const switched = await displayTargetRef.current.switchActiveDisplay(undefined, overlayPreviewPayload);
                      setDisplayTarget(switched);
                      if (switched.blocked) {
                        const reason = switched.blockedReason ?? t("calibration.overlay.blockedReasonUnknown");
                        const code = switched.blockedCode ?? "OVERLAY_OPEN_FAILED";
                        console.warn(`[LumaSync] Test pattern blocked (${code}): ${reason}`);
                        setTestPatternError(t("calibration.overlay.errors.testPatternBlocked", { code, reason }));
                        return;
                      }
                    }
                    const next = await flowRef.current.toggle(shouldEnable);
                    setTestPattern(next);
                    setTestPatternError(null);
                    if (!shouldEnable) {
                      const closed = await displayTargetRef.current.closeActiveDisplay();
                      setDisplayTarget(closed);
                    } else {
                      setDisplayTarget(displayTargetRef.current.clearBlockedState());
                    }
                  } catch (error) {
                    const reason = error instanceof Error ? error.message : String(error);
                    console.warn(`[LumaSync] Test pattern toggle failed: ${reason}`);
                    setTestPatternError(t("calibration.overlay.errors.testPatternToggleFailed", { reason }));
                    try { const s = await flowRef.current.toggle(false); setTestPattern(s); } catch {}
                    try { const c = await displayTargetRef.current.closeActiveDisplay(); setDisplayTarget(c); } catch {}
                  }
                }}
                className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/50 disabled:cursor-not-allowed disabled:opacity-40 ${
                  testPattern.isEnabled ? "bg-cyan-500" : "bg-white/20"
                }`}
              >
                <span
                  className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow-md transition-transform duration-200 ${
                    testPattern.isEnabled ? "translate-x-4" : "translate-x-0"
                  }`}
                />
              </button>
              <span className="select-none text-sm font-medium text-white/70">
                {t("calibration.overlay.testPatternToggle")}
              </span>
            </div>

            {/* Monitor selector */}
            {displayTarget.displays.length > 0 && (
              <>
                <div className="h-4 w-px shrink-0 bg-white/12" />
                <div className="flex items-center gap-1.5">
                  {displayTarget.displays.map((display, index) => {
                    const isSelected = displayTarget.selectedDisplayId === display.id;
                    const isActive = displayTarget.activeDisplayId === display.id;

                    return (
                      <button
                        key={display.id}
                        type="button"
                        onClick={async () => {
                          const selected = displayTargetRef.current.selectDisplay(display.id);
                          setDisplayTarget(selected);
                          if (!testPattern.isEnabled) return;
                          try {
                            const switched = await displayTargetRef.current.switchActiveDisplay(display.id, overlayPreviewPayload);
                            setDisplayTarget(switched);
                            if (switched.blocked) {
                              const reason = switched.blockedReason ?? t("calibration.overlay.blockedReasonUnknown");
                              const code = switched.blockedCode ?? "OVERLAY_OPEN_FAILED";
                              console.warn(`[LumaSync] Display switch blocked (${code}): ${reason}`);
                              setTestPatternError(t("calibration.overlay.errors.displaySwitchBlocked", { code, reason }));
                              const disabledPattern = await flowRef.current.toggle(false);
                              setTestPattern(disabledPattern);
                              return;
                            }
                            setTestPatternError(null);
                            setDisplayTarget(displayTargetRef.current.clearBlockedState());
                          } catch (error) {
                            const reason = error instanceof Error ? error.message : String(error);
                            console.warn(`[LumaSync] Display switch failed: ${reason}`);
                            setTestPatternError(t("calibration.overlay.errors.displaySwitchFailed", { reason }));
                          }
                        }}
                        className={`flex items-center gap-2 rounded-lg border px-2.5 py-1.5 transition-all ${
                          isSelected
                            ? "border-cyan-400/50 bg-cyan-500/15 text-cyan-100"
                            : "border-white/10 bg-white/5 text-white/50 hover:border-white/20 hover:bg-white/8 hover:text-white/80"
                        }`}
                      >
                        <div className="relative shrink-0">
                          <svg viewBox="0 0 16 14" className="h-3.5 w-4 fill-none stroke-current" strokeWidth="1.3">
                            <rect x="0.75" y="0.75" width="14.5" height="9.5" rx="1.5" />
                            <path d="M5.5 12h5M8 10.25V12" strokeLinecap="round" />
                          </svg>
                          {isActive && (
                            <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-emerald-400 ring-1 ring-black/30" />
                          )}
                        </div>
                        <div className="text-left">
                          <div className="text-[11px] font-semibold leading-tight">
                            {t("calibration.overlay.displayCard", { number: index + 1 })}
                            {display.isPrimary ? (
                              <span className="ml-1 text-[9px] font-normal opacity-55">
                                {t("calibration.overlay.primary").toUpperCase()}
                              </span>
                            ) : null}
                          </div>
                          <div className="text-[10px] leading-tight opacity-45">
                            {display.width}×{display.height}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </>
            )}

            {/* Active preview status */}
            {testPattern.isEnabled && (
              <>
                <div className="h-4 w-px shrink-0 bg-white/12" />
                <div className="flex min-w-0 items-center gap-2">
                  {/* Segment tracker */}
                  <div className="flex gap-0.5">
                    {segmentOrder.map((segment) => {
                      const isCurrentSegment = markerSegment === segment;
                      return (
                        <span
                          key={segment}
                          className={`rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-widest transition-colors ${
                            isCurrentSegment ? "bg-cyan-400 text-slate-900" : "text-white/25"
                          }`}
                        >
                          {t(`calibration.editor.counts.${segment}`).charAt(0)}
                        </span>
                      );
                    })}
                  </div>
                  <span className="shrink-0 tabular-nums text-[11px] text-white/35">
                    {testPattern.markerIndex + 1}/{Math.max(1, testPattern.totalLeds)}
                  </span>
                </div>
                {/* Mode indicator */}
                <div
                  className={`flex shrink-0 items-center gap-1.5 text-[11px] ${
                    testPattern.mode === "preview-only" ? "text-amber-300/65" : "text-emerald-300/75"
                  }`}
                >
                  <span
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                      testPattern.mode === "preview-only" ? "bg-amber-400" : "animate-pulse bg-emerald-400"
                    }`}
                  />
                  <span>
                    {testPattern.mode === "preview-only"
                      ? t("calibration.overlay.previewOnly")
                      : t("calibration.overlay.outputActive")}
                  </span>
                </div>
              </>
            )}
          </div>

          {/* Right: action buttons */}
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => {
                const closeState = requestEditorClose(editorState);
                setEditorState(closeState);
                if (closeState.shouldClose) {
                  void flowRef.current.dispose();
                  setTestPattern(flowRef.current.getSnapshot());
                  onClose();
                }
              }}
              className="rounded-lg border border-white/15 px-4 py-2 text-sm font-medium text-white/65 transition-colors hover:border-white/25 hover:bg-white/8 hover:text-white/90"
            >
              {t("calibration.overlay.cancel")}
            </button>
            <button
              type="button"
              disabled={isSaving}
              onClick={async () => {
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
                  onClose();
                } finally {
                  setIsSaving(false);
                }
              }}
              className="rounded-lg bg-white px-4 py-2 text-sm font-semibold text-slate-900 transition-colors hover:bg-white/90 disabled:opacity-50"
            >
              {isSaving ? t("calibration.overlay.saving") : t("calibration.overlay.save")}
            </button>
          </div>
        </div>

        {editorState.confirmDiscard ? (
          <div className="fixed inset-0 z-[60] grid place-items-center bg-black/50 p-4">
            <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-5 shadow-xl dark:border-zinc-700 dark:bg-zinc-900">
              <h3 className="text-base font-semibold text-slate-900 dark:text-zinc-100">
                {t("calibration.overlay.unsavedTitle")}
              </h3>
              <p className="mt-2 text-sm text-slate-600 dark:text-zinc-300">
                {t("calibration.overlay.unsavedDescription")}
              </p>
              <div className="mt-4 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setEditorState((prev) => keepEditing(prev));
                  }}
                  className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 dark:border-zinc-700 dark:text-zinc-200"
                >
                  {t("calibration.overlay.keepEditing")}
                </button>
                <button
                  type="button"
                    onClick={() => {
                      setEditorState((prev) => discardEditorChanges(prev));
                      void flowRef.current.dispose();
                      setTestPattern(flowRef.current.getSnapshot());
                      onClose();
                    }}
                  className="rounded-md bg-rose-600 px-3 py-1.5 text-sm font-semibold text-white"
                >
                  {t("calibration.overlay.discard")}
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    );
  }, [
    activeStep,
    editorState,
    initialConfig,
    initialStep,
    isSaving,
    displayTarget,
    markerSegment,
    onClose,
    onSaved,
    open,
    segmentOrder,
    overlayPreviewPayload,
    t,
    testPattern,
    validationErrors,
  ]);

  if (!open) {
    return null;
  }

  return shell;
}
