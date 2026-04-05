import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

/** Overlay penceresi açıldıktan sonra ana pencereye focus geri verir. */
function reclaimFocus() {
  // İlk deneme hemen, ikinci deneme 150ms sonra (overlay render gecikmesi için)
  void getCurrentWindow().setFocus();
  setTimeout(() => void getCurrentWindow().setFocus(), 150);
}
import { useTranslation } from "react-i18next";

import { shellStore } from "../../persistence/shellStore";
import type { LedCalibrationConfig } from "../model/contracts";
import { buildLedSequence } from "../model/indexMapping";
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
import { DisplayMap } from "./DisplayMap";
import { getSerialConnectionStatus } from "../../device/deviceConnectionApi";
import type { OverlayPreviewPayload } from "../../../shared/contracts/display";

interface CalibrationPageProps {
  initialStep: CalibrationOverlayStep;
  initialConfig?: LedCalibrationConfig;
  onNavigateBack: () => void;
  onSaved: (config: LedCalibrationConfig) => void;
  onStepChange?: (step: CalibrationOverlayStep) => void;
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

function resolveAnchorForBottomMissing(
  currentAnchor: LedCalibrationConfig["startAnchor"],
  nextBottomMissing: number,
) {
  if (nextBottomMissing > 0) return currentAnchor;
  if (currentAnchor === "bottom-gap-right") return "bottom-start";
  if (currentAnchor === "bottom-gap-left") return "bottom-end";
  return currentAnchor;
}

export function CalibrationPage({
  initialStep,
  initialConfig,
  onNavigateBack,
  onSaved,
  onStepChange,
}: CalibrationPageProps) {
  const { t } = useTranslation("common");
  const STEP_ORDER: CalibrationOverlayStep[] = ["template", "display", "editor"];
  const stepIndex = (step: CalibrationOverlayStep) => STEP_ORDER.indexOf(step);

  const [activeStep, setActiveStep] = useState<CalibrationOverlayStep>(initialStep);
  const [maxStepReached, setMaxStepReached] = useState(() => stepIndex(initialStep));

  const goToStep = useCallback((step: CalibrationOverlayStep) => {
    setActiveStep(step);
    setMaxStepReached((prev) => Math.max(prev, stepIndex(step)));
    onStepChange?.(step);
  }, [onStepChange]);
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
    createDisplayTargetState({ openDisplayOverlay, closeDisplayOverlay }),
  );
  const [displayTarget, setDisplayTarget] = useState<DisplayTargetSnapshot>(
    displayTargetRef.current.getSnapshot(),
  );
  const [validationErrors, setValidationErrors] = useState<CalibrationValidationError[] | null>(null);
  const [testPatternError, setTestPatternError] = useState<string | null>(null);

  // Load displays on mount — auto-select when exactly one display is found (P0-2)
  useEffect(() => {
    let cancelled = false;
    void listDisplays()
      .then((displays) => {
        if (cancelled) return;
        let newState = displayTargetRef.current.setDisplays(displays);
        if (displays.length === 1) {
          newState = displayTargetRef.current.selectDisplay(displays[0].id);
        }
        setDisplayTarget(newState);
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
    flowRef.current.setTotalLeds(editorState.current.totalLeds);
    setTestPattern(flowRef.current.getSnapshot());
  }, [editorState.current]);

  // rAF loop while test pattern is active
  useEffect(() => {
    if (!testPattern.isEnabled) return;

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
      if (frameId !== null) window.cancelAnimationFrame(frameId);
    };
  }, [testPattern.isEnabled]);

  // Cleanup on unmount (navigating away)
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
          const reason = displayTarget.blockedReason ?? t("calibration.overlay.blockedReasonUnknown");
          const code = displayTarget.blockedCode ?? "OVERLAY_OPEN_FAILED";
          setTestPatternError(t("calibration.overlay.errors.testPatternBlocked", { code, reason }));
          return;
        }
        const switched = await displayTargetRef.current.switchActiveDisplay(undefined, overlayPreviewPayload);
        setDisplayTarget(switched);
        reclaimFocus();
        if (switched.blocked) {
          const reason = switched.blockedReason ?? t("calibration.overlay.blockedReasonUnknown");
          const code = switched.blockedCode ?? "OVERLAY_OPEN_FAILED";
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
      setTestPatternError(t("calibration.overlay.errors.testPatternToggleFailed", { reason }));
      try { const s = await flowRef.current.toggle(false); setTestPattern(s); } catch {}
      try { const c = await displayTargetRef.current.closeActiveDisplay(); setDisplayTarget(c); } catch {}
    }
  }, [testPattern.isEnabled, displayTarget, overlayPreviewPayload, t]);

  function handleClose() {
    const closeState = requestEditorClose(editorState);
    setEditorState(closeState);
    if (closeState.shouldClose) {
      void flowRef.current.dispose();
      setTestPattern(flowRef.current.getSnapshot());
      onNavigateBack();
    }
  }

  return (
    <div className="flex h-full flex-col">
      {/* ── Header ── */}
      <div className="flex shrink-0 items-center gap-4 border-b border-slate-200/70 px-6 py-3 dark:border-zinc-800">
        <h1 className="text-sm font-semibold text-slate-900 dark:text-zinc-100">
          {t("calibration.page.title")}
        </h1>

        {/* Step indicator */}
        <div className="flex items-center gap-1.5 rounded-full border border-slate-200/80 bg-slate-50 px-3 py-1 dark:border-zinc-700 dark:bg-zinc-800/60">
          <StepIndicator
            number={1}
            label={t("calibration.page.stepTemplate")}
            active={activeStep === "template"}
            done={maxStepReached >= stepIndex("template") && activeStep !== "template"}
            onClick={activeStep !== "template" ? () => goToStep("template") : undefined}
          />
          <StepArrow />
          <StepIndicator
            number={2}
            label={t("calibration.page.stepDisplay")}
            active={activeStep === "display"}
            done={maxStepReached >= stepIndex("display") && activeStep !== "display"}
            onClick={maxStepReached >= stepIndex("display") && activeStep !== "display" ? () => goToStep("display") : undefined}
          />
          <StepArrow />
          <StepIndicator
            number={3}
            label={t("calibration.page.stepEditor")}
            active={activeStep === "editor"}
            done={maxStepReached >= stepIndex("editor") && activeStep !== "editor"}
            onClick={maxStepReached >= stepIndex("editor") && activeStep !== "editor" ? () => goToStep("editor") : undefined}
          />
        </div>

        {/* Dirty badge */}
        {editorState.isDirty && (
          <span className="rounded-md bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700 dark:bg-amber-500/20 dark:text-amber-300">
            {t("calibration.editor.dirty")}
          </span>
        )}
      </div>

      {/* ── Content ── */}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 py-6">
        {activeStep === "template" ? (
          <CalibrationTemplateStep
            selectedTemplateId={editorState.current.templateId}
            onSelectTemplate={(templateId) => {
              const config = applyTemplate(templateId);
              setEditorState((prev) => loadEditorConfig(prev, config));
            }}
          />
        ) : activeStep === "display" ? (
          <div className="flex h-full flex-col items-center justify-center gap-8">
            <div className="text-center">
              <h2 className="text-base font-semibold text-slate-900 dark:text-zinc-100">
                {t("calibration.page.displayTitle")}
              </h2>
              <p className="mt-1 text-sm text-slate-500 dark:text-zinc-400">
                {t("calibration.page.displayDescription")}
              </p>
            </div>

            {displayTarget.displays.length > 0 ? (
              <DisplayMap
                displays={displayTarget.displays}
                selectedId={displayTarget.selectedDisplayId}
                activeId={displayTarget.activeDisplayId}
                isSwitching={displayTarget.isSwitching}
                onSelect={async (displayId) => {
                  const selected = displayTargetRef.current.selectDisplay(displayId);
                  setDisplayTarget(selected);
                  if (!testPattern.isEnabled) return;
                  try {
                    const switched = await displayTargetRef.current.switchActiveDisplay(displayId, overlayPreviewPayload);
                    setDisplayTarget(switched);
                    reclaimFocus();
                    if (switched.blocked) {
                      const reason = switched.blockedReason ?? t("calibration.overlay.blockedReasonUnknown");
                      const code = switched.blockedCode ?? "OVERLAY_OPEN_FAILED";
                      setTestPatternError(t("calibration.overlay.errors.displaySwitchBlocked", { code, reason }));
                    } else {
                      setTestPatternError(null);
                    }
                  } catch (error) {
                    const reason = error instanceof Error ? error.message : String(error);
                    setTestPatternError(t("calibration.overlay.errors.displaySwitchFailed", { reason }));
                  }
                }}
                maxWidth={520}
                maxHeight={200}
              />
            ) : (
              <div className="flex flex-col items-center gap-2 text-slate-400 dark:text-zinc-500">
                <svg viewBox="0 0 24 24" className="h-10 w-10 opacity-40" fill="none" stroke="currentColor" strokeWidth="1.4">
                  <rect x="2" y="3" width="20" height="14" rx="2" />
                  <path d="M8 21h8M12 17v4" />
                </svg>
                <span className="text-sm">{t("calibration.overlay.noDisplays")}</span>
              </div>
            )}
          </div>
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
                return updateEditorConfig(prev, { bottomMissing: count, startAnchor });
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
            onResetTemplate={() => goToStep("template")}
          />
        )}
      </div>

      {/* ── Error strip ── */}
      {(testPatternError || displayTarget.blocked || (validationErrors && validationErrors.length > 0)) && (
        <div className="shrink-0 mx-4 mb-2 flex flex-col gap-1 rounded-lg border border-rose-500/25 bg-rose-50 px-3.5 py-2.5 dark:bg-rose-950/60">
          {displayTarget.blocked && (
            <ErrorLine text={t("calibration.overlay.blockedReason", {
              code: displayTarget.blockedCode ?? "OVERLAY_OPEN_FAILED",
              reason: displayTarget.blockedReason ?? t("calibration.overlay.blockedReasonUnknown"),
            })} />
          )}
          {testPatternError && <ErrorLine text={testPatternError} />}
          {validationErrors?.map((error) => (
            <ErrorLine key={`${error.code}:${error.field}`} text={`${error.code}: ${error.field}`} />
          ))}
        </div>
      )}

      {/* ── Action bar (tüm adımlarda sabit) ── */}
      <div className="shrink-0 flex items-center gap-3 border-t border-slate-200/70 bg-white/60 px-4 py-3 backdrop-blur-sm dark:border-zinc-800 dark:bg-zinc-900/60">
        {/* Sol: preview toggle */}
        <div className="flex min-w-0 flex-1 items-center gap-4 overflow-hidden">
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              role="switch"
              aria-checked={testPattern.isEnabled}
              disabled={displayTarget.isSwitching || displayTarget.displays.length === 0}
              onClick={() => void handlePreviewToggle()}
              className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/50 disabled:cursor-not-allowed disabled:opacity-40 ${
                testPattern.isEnabled ? "bg-cyan-500" : "bg-slate-300 dark:bg-zinc-600"
              }`}
            >
              <span
                className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow-md transition-transform duration-200 ${
                  testPattern.isEnabled ? "translate-x-4" : "translate-x-0"
                }`}
              />
            </button>
            <span className="select-none text-xs font-medium text-slate-600 dark:text-zinc-400">
              {t("calibration.overlay.testPatternToggle")}
            </span>
          </div>

          {/* Preview durum göstergesi */}
          {testPattern.isEnabled && (
            <>
              <div className="h-5 w-px shrink-0 bg-slate-200/80 dark:bg-zinc-700" />
              <div className={`flex shrink-0 items-center gap-1.5 text-[11px] ${
                testPattern.mode === "preview-only"
                  ? "text-amber-600 dark:text-amber-400"
                  : "text-emerald-600 dark:text-emerald-400"
              }`}>
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                  testPattern.mode === "preview-only" ? "bg-amber-400" : "animate-pulse bg-emerald-400"
                }`} />
                <span>
                  {testPattern.mode === "preview-only"
                    ? t("calibration.overlay.previewOnly")
                    : t("calibration.overlay.outputActive")}
                </span>
              </div>
            </>
          )}
        </div>

        {/* Sağ: adıma göre buton */}
        <div className="flex shrink-0 items-center gap-2">
          {activeStep === "template" && (
            <button
              type="button"
              disabled={!editorState.current.templateId}
              onClick={() => goToStep("display")}
              className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-slate-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {t("calibration.page.displayContinue")} →
            </button>
          )}
          {activeStep === "display" && (
            <>
              <button
                type="button"
                onClick={() => goToStep("template")}
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                ← {t("calibration.page.back")}
              </button>
              <button
                type="button"
                disabled={!displayTarget.selectedDisplayId && displayTarget.displays.length > 0}
                onClick={() => goToStep("editor")}
                className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-slate-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {t("calibration.page.displayContinue")} →
              </button>
            </>
          )}
          {activeStep === "editor" && (
            <>
              <button
                type="button"
                onClick={handleClose}
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
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
                    onNavigateBack();
                  } finally {
                    setIsSaving(false);
                  }
                }}
                className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-slate-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200 disabled:opacity-50"
              >
                {isSaving ? t("calibration.overlay.saving") : t("calibration.overlay.save")}
              </button>
            </>
          )}
        </div>
      </div>

      {/* ── Discard confirmation ── */}
      {editorState.confirmDiscard && (
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
                onClick={() => setEditorState((prev) => keepEditing(prev))}
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
                  onNavigateBack();
                }}
                className="rounded-md bg-rose-600 px-3 py-1.5 text-sm font-semibold text-white"
              >
                {t("calibration.overlay.discard")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StepIndicator({
  number,
  label,
  active,
  done,
  onClick,
}: {
  number: number;
  label: string;
  active: boolean;
  done: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className={`flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium transition-colors disabled:cursor-default ${
        active
          ? "text-slate-900 dark:text-zinc-100"
          : done
            ? "cursor-pointer text-slate-500 hover:text-slate-700 dark:text-zinc-400 dark:hover:text-zinc-200"
            : "text-slate-400 dark:text-zinc-500"
      }`}
    >
      <span
        className={`inline-flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-bold ${
          active
            ? "bg-slate-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
            : done
              ? "bg-emerald-500 text-white"
              : "bg-slate-200 text-slate-500 dark:bg-zinc-700 dark:text-zinc-400"
        }`}
      >
        {done ? (
          <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M2 6l3 3 5-5" />
          </svg>
        ) : number}
      </span>
      {label}
    </button>
  );
}

function StepArrow() {
  return (
    <svg viewBox="0 0 12 12" className="h-3 w-3 shrink-0 text-slate-400 dark:text-zinc-500" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <path d="M3 6h6M7 4l2 2-2 2" />
    </svg>
  );
}

function ErrorLine({ text }: { text: string }) {
  return (
    <p className="flex items-start gap-2 text-xs text-rose-700 dark:text-rose-300">
      <svg className="mt-0.5 h-3.5 w-3.5 shrink-0" viewBox="0 0 16 16" fill="none">
        <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.4" />
        <path d="M8 5v3.5M8 10.5v.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
      <span>{text}</span>
    </p>
  );
}
