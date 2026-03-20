import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { shellStore } from "../../persistence/shellStore";
import type { LedCalibrationConfig } from "../model/contracts";
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
import { createDefaultTestPatternFlow, type TestPatternSnapshot } from "../state/testPatternFlow";
import type { CalibrationOverlayStep } from "../state/entryFlow";
import { CalibrationEditorCanvas } from "./CalibrationEditorCanvas";
import { CalibrationTemplateStep } from "./CalibrationTemplateStep";
import { getSerialConnectionStatus } from "../../device/deviceConnectionApi";

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
  const seen = new Set<string>();
  const order: string[] = [];

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
  const [validationErrors, setValidationErrors] = useState<CalibrationValidationError[] | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    setActiveStep(initialStep);
    setEditorState(buildInitialEditorState(initialConfig));
    setValidationErrors(null);
    flowRef.current.setTotalLeds((initialConfig ?? resetToManual()).totalLeds);
    setTestPattern(flowRef.current.getSnapshot());
  }, [open, initialStep, initialConfig]);

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
      setTestPattern(flowRef.current.getSnapshot());
    });
  }, [open]);

  useEffect(() => {
    return () => {
      void flowRef.current.dispose();
    };
  }, []);

  const sequence = useMemo(() => buildLedSequence(editorState.current), [editorState.current]);
  const markerSegment = resolveLedSequenceItem(sequence, testPattern.markerIndex)?.segment ?? "top";
  const segmentOrder = useMemo(() => buildSegmentOrder(sequence), [sequence]);

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

        <div className="flex-1 overflow-auto">
          {activeStep === "template" ? (
            <CalibrationTemplateStep
              selectedTemplateId={editorState.current.templateId}
              onSelectTemplate={(templateId) => {
                const config = applyTemplate(templateId);
                setEditorState((prev) => loadEditorConfig(prev, config));
                setActiveStep("editor");
              }}
              onSkipTemplate={() => {
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
              onBottomGapChange={(px) => {
                setEditorState((prev) => updateEditorConfig(prev, { bottomGapPx: px }));
                setValidationErrors(null);
              }}
              onResetTemplate={() => {
                setActiveStep("template");
              }}
            />
          )}
        </div>

        <div className="mt-4 flex items-center justify-end gap-3 rounded-xl border border-white/20 bg-black/30 px-4 py-3">
          <div className="mr-auto flex flex-wrap items-center gap-2 text-xs text-white/90">
            <label className="inline-flex items-center gap-2 rounded-md border border-white/30 px-2 py-1">
              <input
                type="checkbox"
                checked={testPattern.isEnabled}
                onChange={async (event) => {
                  const next = await flowRef.current.toggle(event.target.checked);
                  setTestPattern(next);
                }}
              />
              <span>{t("calibration.overlay.testPatternToggle")}</span>
            </label>
            {testPattern.isEnabled ? (
              <>
                <span className="rounded-md bg-white/15 px-2 py-1">
                  {t("calibration.overlay.previewProgress", {
                    led: testPattern.markerIndex + 1,
                    total: Math.max(1, testPattern.totalLeds),
                    segment: t(`calibration.editor.counts.${markerSegment}`),
                  })}
                </span>
                <div className="flex items-center gap-1 rounded-md border border-cyan-300/45 bg-cyan-500/10 px-1.5 py-1">
                  {segmentOrder.map((segment) => {
                    const isActive = markerSegment === segment;

                    return (
                      <span
                        key={segment}
                        className={`rounded px-1.5 py-0.5 text-[11px] font-semibold transition-colors ${
                          isActive
                            ? "bg-cyan-300 text-slate-900"
                            : "bg-white/10 text-white/80"
                        }`}
                      >
                        {t(`calibration.editor.counts.${segment}`)}
                      </span>
                    );
                  })}
                </div>
              </>
            ) : null}
            {testPattern.isEnabled && testPattern.mode === "preview-only" ? (
              <span className="rounded-md border border-amber-300/60 bg-amber-500/20 px-2 py-1 text-amber-100">
                {t("calibration.overlay.previewOnly")}
              </span>
            ) : null}
          </div>
          {validationErrors && validationErrors.length > 0 ? (
            <ul className="mr-auto flex flex-col gap-1 text-xs text-rose-400">
              {validationErrors.map((error) => (
                <li key={`${error.code}:${error.field}`}>
                  {error.code}: {error.field}
                </li>
              ))}
            </ul>
          ) : null}
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
            className="rounded-lg border border-white/30 px-4 py-2 text-sm font-medium text-white hover:bg-white/10"
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
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900"
          >
            {isSaving ? t("calibration.overlay.saving") : t("calibration.overlay.save")}
          </button>
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
    markerSegment,
    onClose,
    onSaved,
    open,
    segmentOrder,
    t,
    testPattern,
    validationErrors,
  ]);

  if (!open) {
    return null;
  }

  return shell;
}
