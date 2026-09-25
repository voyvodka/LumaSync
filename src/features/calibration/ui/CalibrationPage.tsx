import { useEffect, useRef, useState, useCallback, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { PREVIEW_OPEN_FAILURE_COPY } from "@/features/preview/previewOpenFailure";
import type { LeaveGuard } from "@/features/shell/navigationStore";
import type { LedCalibrationConfig, LedSegmentCounts } from "../model/contracts";
import type { CalibrationNotice } from "../model/calibrationNotices";
import { estimateStripPower } from "../model/powerEstimate";
import {
  edgeOfAnchor,
  endpointOfAnchor,
  type AnchorEdge,
  type AnchorEndpoint,
} from "../model/startAnchor";
import type { CalibrationValidationCode } from "../model/validation";
import { litEdges } from "../model/splitTotal";
import { useCalibrationSession } from "../state/useCalibrationSession";
import { dockChoiceClass, FOCUS_RING } from "./dockStyles";
import { LedRoomCanvas } from "./LedRoomCanvas";
import { TotalCountStep } from "./TotalCountStep";
import { clamp } from "@/shared/lib/math";
import { Callout } from "@/shared/ui/Callout";
import { ConfirmDialog } from "@/shared/ui/ConfirmDialog";
import { Segmented } from "@/shared/ui/Segmented";
import { useRadioGroup } from "@/shared/ui/useRadioGroup";
import type { TranslationKey } from "@/features/i18n/catalogue";

interface CalibrationPageProps {
  initialConfig?: LedCalibrationConfig;
  /** Counts proposed by the room map, opened as an unsaved draft over the saved layout. */
  draftCounts?: LedSegmentCounts | null;
  onNavigateBack: () => void;
  onSaved: (config: LedCalibrationConfig) => void;
  /** Lets the page hold a navigation away while its draft is unsaved. */
  registerLeaveGuard?: (guard: LeaveGuard | null) => void;
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

export function CalibrationPage({
  initialConfig,
  draftCounts,
  onNavigateBack,
  onSaved,
  registerLeaveGuard,
}: CalibrationPageProps) {
  const { t } = useTranslation();
  const {
    config,
    confirmDiscard,
    countsFromRoomMap,
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
  } = useCalibrationSession({ initialConfig, draftCounts, onNavigateBack, onSaved, registerLeaveGuard });

  const { counts, bottomMissing, startAnchor, direction, totalLeds } = config;
  const currentEdge = edgeOfAnchor(startAnchor);
  const currentEndpoint = endpointOfAnchor(startAnchor);
  const endpointOptions: AnchorEndpoint[] =
    currentEdge === "bottom" && bottomMissing > 0
      ? ["start", "gap-right", "gap-left", "end"]
      : ["start", "end"];
  const meterLength = (totalLeds / 60).toFixed(1);
  const power = estimateStripPower(totalLeds, chipType);
  // `aria-disabled`, not `disabled`: a button disabled under the keyboard drops
  // focus to the document, and a switch lasts only as long as the overlay takes.
  // A test pattern start or stop holds both too; the session ignores a press then.
  const isSwitching = displayTarget.isSwitching || isTogglingTestPattern;
  // Not `isDisabled` while switching: that would take every monitor out of the
  // tab order for the length of a switch. The session ignores the pick instead.
  const { itemProps: displayItemProps } = useRadioGroup({
    values: displayTarget.displays.map((display) => display.id),
    value: displayTarget.selectedDisplayId ?? null,
    onChange: (id) => {
      const display = displayTarget.displays.find((candidate) => candidate.id === id);
      if (display) void handleSelectDisplay(display);
    },
  });

  // The step unmounts under the button that closed it; focus lands on the
  // control that brings it back rather than on the document. Opening it by
  // hand moves focus into the step's field.
  const changeTotalRef = useRef<HTMLButtonElement | null>(null);
  const [focusAfterStep, setFocusAfterStep] = useState<"step" | "change" | null>(null);
  useEffect(() => {
    if (focusAfterStep === "change" && !totalStepOpen) {
      changeTotalRef.current?.focus();
      setFocusAfterStep(null);
    }
  }, [focusAfterStep, totalStepOpen]);

  const hasErrors = Boolean(
    testPatternError
      || previewOpenFailure
      || overlayBlocked
      || saveError
      || (validationErrors && validationErrors.length > 0),
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Error strip */}
      {hasErrors && (
        <div role="alert" className="shrink-0 mx-4 mt-3 flex flex-col gap-1">
          {overlayBlocked && <NoticeCallout notice={overlayBlocked} />}
          {testPatternError && <NoticeCallout notice={testPatternError} />}
          {saveError && (
            <NoticeCallout
              notice={saveError}
              action={{
                label: t("calibration:overlay.retrySave"),
                onClick: () => void handleSave(),
                pending: isSaving,
              }}
            />
          )}
          {previewOpenFailure && (
            <Callout tone="error" announce={false}>
              {t(PREVIEW_OPEN_FAILURE_COPY[previewOpenFailure])}
            </Callout>
          )}
          {validationErrors?.map((error) => (
            <Callout key={`${error.code}:${error.field}`} tone="error" announce={false}>
              {t(VALIDATION_MESSAGE_KEYS[error.code], { field: error.field })}
            </Callout>
          ))}
        </div>
      )}

      {(countsFromRoomMap || testLayoutStale) && (
        <div className="shrink-0 mx-4 mt-3 flex flex-col gap-1">
          {countsFromRoomMap && (
            <Callout tone="info" testId="calibration-counts-from-room-map">
              {t("calibration:page.countsFromRoomMap")}
            </Callout>
          )}
          {testLayoutStale && (
            <Callout tone={draftTestable ? "info" : "warning"} testId="calibration-test-stale">
              {draftTestable
                ? t("calibration:page.testUpdating")
                : t("calibration:page.testKeepsLastValid")}
            </Callout>
          )}
        </div>
      )}

      {/* Main: stage + dock */}
      <div className="flex min-h-0 flex-1">
        {/* Stage */}
        <div className="flex min-w-0 flex-1 flex-col">
          {/* Stage header */}
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-1.5 border-b border-line px-6 py-2.5">
            <div className="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
              <span className="whitespace-nowrap font-mono text-[10px] uppercase tracking-[0.16em] text-amber">
                {t("calibration:page.totalStrip")}
              </span>
              <span className="font-mono text-lg font-semibold leading-none text-ink">
                {totalLeds}
              </span>
              <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-dim">
                {t("calibration:page.ledsUnit")}
              </span>
              <span aria-hidden className="font-mono text-[10px] text-ink-faint">·</span>
              <span
                className="whitespace-nowrap font-mono text-[10px] text-ink-dim"
                title={t("calibration:page.powerHint")}
                data-testid="calibration-power-estimate"
              >
                {t("calibration:page.lengthAndPower", {
                  meters: meterLength,
                  watts: power.watts,
                  amps: power.amps.toFixed(1),
                })}
              </span>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={() => void handleOpenPreview()}
                title={t("preview:entry.ledSetupHint")}
                className={`inline-flex min-h-8 items-center gap-1.5 rounded-md border border-amber/40 bg-amber/10 px-2.5 py-1.5 text-xs font-medium text-amber transition-colors hover:bg-amber/20 ${FOCUS_RING}`}
              >
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
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
                className={`inline-flex min-h-8 items-center gap-1.5 rounded-md border border-line-2 bg-panel px-2.5 py-1.5 text-xs font-medium text-ink transition-colors hover:bg-panel-2 ${FOCUS_RING}`}
              >
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
                  <path d="M3 12l3-3 4 4 8-8 3 3" />
                  <path d="M21 6v6h-6" />
                </svg>
                {t("calibration:page.reset")}
              </button>
              <button
                type="button"
                disabled={displayTarget.displays.length === 0}
                aria-disabled={isSwitching || undefined}
                onClick={() => void handlePreviewToggle()}
                className={`inline-flex min-h-8 items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40 aria-disabled:cursor-not-allowed aria-disabled:opacity-40 ${FOCUS_RING} ${
                  testPattern.isEnabled
                    ? "bg-amber text-bg hover:bg-amber"
                    : "border border-line-2 bg-panel text-ink hover:bg-panel-2"
                }`}
              >
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
                  <path d="M12 2v4M12 18v4M4.9 4.9l2.8 2.8M16.3 16.3l2.8 2.8M2 12h4M18 12h4M4.9 19.1l2.8-2.8M16.3 7.7l2.8-2.8" />
                </svg>
                {testPattern.isEnabled
                  ? t("calibration:page.stopTestPattern")
                  : t("calibration:page.runTestPattern")}
              </button>
            </div>
            <p className="w-full text-[10.5px] leading-snug text-ink-faint">
              {t("calibration:page.testModesHint")}
            </p>
          </div>

          {/* Canvas */}
          <div className="relative min-h-0 flex-1 overflow-hidden bg-black/30">
            <LedRoomCanvas config={config} />
            {testPattern.isEnabled && (
              <div className={`absolute top-3 left-3 flex items-center gap-1.5 rounded-md px-2 py-1 font-mono text-[10px] uppercase tracking-[0.12em] ${
                testPattern.mode === "preview-only"
                  ? "bg-amber/15 text-amber"
                  : "bg-green/15 text-green"
              }`}>
                <span className={`h-1.5 w-1.5 rounded-full ${
                  testPattern.mode === "preview-only" ? "bg-amber" : "animate-pulse bg-green"
                }`} />
                {testPattern.mode === "preview-only"
                  ? t("calibration:overlay.previewOnly")
                  : t("calibration:overlay.outputActive")}
              </div>
            )}
          </div>

          {/* Edge summary */}
          <div className="grid shrink-0 grid-cols-4 border-t border-line">
            <EdgeSummary label={t("calibration:page.edgeTop")} value={counts.top} />
            <EdgeSummary label={t("calibration:page.edgeRight")} value={counts.right} />
            <EdgeSummary label={t("calibration:page.edgeBottom")} value={counts.bottom} />
            <EdgeSummary label={t("calibration:page.edgeLeft")} value={counts.left} />
          </div>
        </div>

        {/* Dock */}
        <div className="flex w-[268px] shrink-0 flex-col border-l border-line bg-black/30">
          <div className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto p-4">
          <DockSection
            title={t("calibration:page.dockCaptureSource")}
            hint={t("calibration:page.dockCaptureSourceHint")}
          >
            <div className="flex flex-col gap-1.5">
              {displayTarget.displays.length === 0 ? (
                <div className="rounded-md border border-dashed border-line-2 px-3 py-2 text-xs text-ink-dim">
                  {t("calibration:overlay.noDisplays")}
                </div>
              ) : (
                <div
                  role="radiogroup"
                  aria-label={t("calibration:page.dockCaptureSource")}
                  className="flex flex-col gap-1.5"
                >
                  {displayTarget.displays.map((display) => {
                    const isSelected = display.id === displayTarget.selectedDisplayId;
                    return (
                      <button
                        key={display.id}
                        type="button"
                        {...displayItemProps(display.id)}
                        aria-disabled={isSwitching || undefined}
                        className={`flex items-center gap-2 rounded-md border px-2.5 py-2 text-left transition-colors aria-disabled:cursor-not-allowed aria-disabled:opacity-40 ${FOCUS_RING} ${
                          isSelected
                            ? "border-amber/40 bg-amber/10 text-amber"
                            : "border-line-2 bg-panel hover:border-line-2"
                        }`}
                      >
                        <div className={`h-4 w-6 shrink-0 rounded-sm border ${isSelected ? "border-amber" : "border-line-2"}`}>
                          {isSelected && <div className="h-full w-full rounded-sm bg-amber/20" />}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-mono text-[10px] uppercase tracking-[0.1em] font-medium">
                            {display.label}
                          </div>
                          <div className="truncate font-mono text-[9px] text-ink-dim">
                            {display.width} × {display.height}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </DockSection>

          {totalStepOpen ? (
            <DockSection title={t("calibration:page.totalStep.title")}>
              <TotalCountStep
                initialTotal={knownTotal ?? (totalLeds > 0 ? totalLeds : null)}
                initialEdges={litEdges(counts)}
                knownTotal={knownTotal}
                chipType={chipType}
                autoFocus={focusAfterStep === "step"}
                onApply={(total, edges) => {
                  setFocusAfterStep("change");
                  handleApplyTotal(total, edges);
                }}
                onSkip={() => {
                  setFocusAfterStep("change");
                  handleCloseTotalStep();
                }}
              />
            </DockSection>
          ) : (
            <DockSection title={t("calibration:page.dockLedCountPerEdge")}>
              <div className="flex flex-col gap-1.5">
                <CountStepper label={t("calibration:page.edgeTop")} value={counts.top} onChange={(v) => handleCountChange("top", v)} />
                <CountStepper label={t("calibration:page.edgeRight")} value={counts.right} onChange={(v) => handleCountChange("right", v)} />
                <CountStepper label={t("calibration:page.edgeBottom")} value={counts.bottom} onChange={(v) => handleCountChange("bottom", v)} />
                <CountStepper label={t("calibration:page.edgeLeft")} value={counts.left} onChange={(v) => handleCountChange("left", v)} />
                <button
                  ref={changeTotalRef}
                  type="button"
                  onClick={() => {
                    setFocusAfterStep("step");
                    handleOpenTotalStep();
                  }}
                  className={`min-h-8 self-start rounded-md px-1 text-xs text-amber underline-offset-2 hover:underline ${FOCUS_RING}`}
                >
                  {t("calibration:page.totalStep.change")}
                </button>
              </div>
            </DockSection>
          )}

          {counts.bottom > 0 && (
            <DockSection title={t("calibration:page.dockStandGap")}>
              <StandGapStepper
                value={bottomMissing}
                max={counts.bottom}
                onChange={handleBottomMissingChange}
              />
            </DockSection>
          )}

          <DockSection
            title={t("calibration:page.dockStartAnchor")}
            hint={t("calibration:page.dockStartAnchorHint")}
          >
            <Segmented
              className="grid grid-cols-4 gap-1"
              ariaLabel={t("calibration:page.startEdgeGroup")}
              value={currentEdge}
              onChange={handleEdgeChange}
              options={(["top", "right", "bottom", "left"] as const).map((edge) => ({
                value: edge,
                label: t(START_EDGE_LABEL_KEYS[edge]),
                disabled: counts[edge] === 0,
                className: dockChoiceClass(
                  currentEdge === edge,
                  "px-1.5 font-mono text-[9px] uppercase disabled:cursor-not-allowed disabled:opacity-35",
                ),
              }))}
            />
            <Segmented
              className="mt-2 flex flex-wrap gap-1"
              ariaLabel={t("calibration:page.anchorGroup")}
              value={currentEndpoint}
              onChange={handleEndpointChange}
              options={endpointOptions.map((endpoint) => ({
                value: endpoint,
                label: t(ENDPOINT_LABEL_KEYS[endpoint]),
                className: dockChoiceClass(
                  currentEndpoint === endpoint,
                  "flex-1 px-2 font-mono text-[9px] uppercase",
                ),
              }))}
            />
          </DockSection>

          <DockSection
            title={t("calibration:page.dockDirection")}
            hint={t("calibration:page.dockDirectionHint")}
          >
            <Segmented
              className="grid grid-cols-2 gap-1"
              ariaLabel={t("calibration:page.dockDirection")}
              value={direction}
              onChange={handleDirectionChange}
              options={(["cw", "ccw"] as const).map((candidate) => ({
                value: candidate,
                label: t(
                  candidate === "cw"
                    ? "calibration:page.dockDirectionCw"
                    : "calibration:page.dockDirectionCcw",
                ),
                className: dockChoiceClass(direction === candidate, "px-2 font-mono text-[10px]"),
              }))}
            />
          </DockSection>

          </div>

          {/* Sticky Save/Cancel footer */}
          <div className="flex shrink-0 items-center gap-2 border-t border-line bg-black/30 px-4 py-3">
            <button
              type="button"
              onClick={handleClose}
              className={`min-h-8 flex-1 rounded-md border border-line-2 px-3 py-1.5 text-xs font-medium text-ink transition-colors hover:bg-panel-2 ${FOCUS_RING}`}
            >
              {t("calibration:overlay.cancel")}
            </button>
            <button
              type="button"
              disabled={isSaving}
              aria-busy={isSaving}
              onClick={() => void handleSave()}
              className={`min-h-8 flex-1 rounded-md bg-amber px-3 py-1.5 text-xs font-semibold text-bg transition-colors hover:bg-amber disabled:opacity-50 ${FOCUS_RING} focus-visible:ring-offset-2 focus-visible:ring-offset-bg`}
            >
              {isSaving ? t("calibration:overlay.saving") : t("calibration:overlay.save")}
            </button>
          </div>
        </div>
      </div>

      {/* Discard confirmation */}
      {/* Escape means "keep editing" — the safe answer for a dialog whose other
          option throws work away. */}
      {confirmDiscard && (
        <ConfirmDialog
          tone="danger"
          title={t("calibration:overlay.unsavedTitle")}
          body={t("calibration:overlay.unsavedDescription")}
          cancelLabel={t("calibration:overlay.keepEditing")}
          confirmLabel={t("calibration:overlay.discard")}
          onCancel={handleKeepEditing}
          onConfirm={handleDiscard}
          testId="calibration-discard-dialog"
        />
      )}
    </div>
  );
}

/** An error in the user's words, with the backend's own code under it for a bug report. */
function NoticeCallout({
  notice,
  action,
}: {
  notice: CalibrationNotice;
  action?: { label: string; onClick: () => void; pending?: boolean };
}) {
  const { t } = useTranslation();
  return (
    <Callout tone="error" announce={false} action={action}>
      {t(notice.key)}
      {notice.detail && (
        <span className="mt-0.5 block break-all font-mono text-[10px] text-ink-faint">
          {notice.detail}
        </span>
      )}
    </Callout>
  );
}

function DockSection({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-2 font-mono text-[9.5px] uppercase tracking-[0.18em] text-ink-dim">
        <span className="h-px w-2.5 bg-line-2" />
        {title}
      </div>
      {hint && <p className="mb-1.5 text-[10.5px] leading-snug text-ink-faint">{hint}</p>}
      {children}
    </div>
  );
}

function EdgeSummary({ label, value }: { label: string; value: number }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-baseline gap-1.5 px-4 py-2">
      <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-ink-dim">{label}</span>
      <span className="font-mono text-sm font-medium text-ink">{value}</span>
      <span className="font-mono text-[9px] uppercase tracking-[0.1em] text-ink-faint">{t("calibration:page.ledUnit")}</span>
    </div>
  );
}

const STEP_BUTTON =
  `flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-line-2 text-sm leading-none text-ink-dim transition-colors hover:border-amber hover:text-amber disabled:cursor-not-allowed disabled:opacity-35 ${FOCUS_RING}`;
const STEP_INPUT =
  `h-8 w-14 min-w-0 rounded-md border border-line-2 bg-bg/40 px-1.5 text-center font-mono text-sm font-medium text-ink outline-none ${FOCUS_RING}`;

// Number stepper with always-editable keyboard input.
// `value` is the committed integer; `draft` mirrors the user's
// in-flight typing so the field can hold an empty / partial value
// without bouncing back to `value` mid-keystroke. ENTER and blur
// commit; ESC reverts; +/- buttons call onChange(value ± 1) so the
// stepper preserves the original delta affordance via the unified
// absolute-value API. type="text" + inputMode="numeric" gives the
// mobile numeric keyboard without rendering the native spinner that
// would visually conflict with our +/- buttons.
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
    <div className="flex items-center gap-1.5 rounded-md border border-line-2 bg-panel px-2 py-1">
      <div className="min-w-0 flex-1 truncate font-mono text-[9px] uppercase tracking-[0.14em] text-ink-dim">{label}</div>
      <button
        type="button"
        disabled={value <= 0}
        onClick={() => onChange(value - 1)}
        aria-label={t("calibration:page.aria.countDecrease", { label })}
        className={STEP_BUTTON}
      >
        −
      </button>
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
        className={STEP_INPUT}
      />
      <button
        type="button"
        onClick={() => onChange(value + 1)}
        aria-label={t("calibration:page.aria.countIncrease", { label })}
        className={STEP_BUTTON}
      >
        +
      </button>
    </div>
  );
}

const START_EDGE_LABEL_KEYS = {
  top: "calibration:page.startEdgeTop",
  right: "calibration:page.startEdgeRight",
  bottom: "calibration:page.startEdgeBottom",
  left: "calibration:page.startEdgeLeft",
} as const satisfies Record<AnchorEdge, TranslationKey>;

const ENDPOINT_LABEL_KEYS = {
  start: "calibration:page.anchorStart",
  "gap-right": "calibration:page.anchorGapRight",
  "gap-left": "calibration:page.anchorGapLeft",
  end: "calibration:page.anchorEnd",
} as const satisfies Record<AnchorEndpoint, TranslationKey>;

// Same keyboard-input pattern as CountStepper, with the
// `max` cap (counts.bottom) preserved on commit so an out-of-range
// keystroke still clamps. The "/ {max}" sibling keeps the available
// headroom in view while typing.
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
    <div className="flex items-center gap-1.5 rounded-md border border-line-2 bg-panel px-2 py-1">
      <div className="min-w-0 flex-1 truncate font-mono text-[9px] uppercase tracking-[0.14em] text-ink-dim">
        {t("calibration:page.ledUnit")}
        <span className="ml-1.5 normal-case tracking-normal text-ink-faint">/ {max}</span>
      </div>
      <button
        type="button"
        disabled={value <= 0}
        onClick={() => onChange(value - 1)}
        aria-label={t("calibration:page.aria.gapDecrease")}
        className={STEP_BUTTON}
      >
        −
      </button>
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
        className={STEP_INPUT}
      />
      <button
        type="button"
        disabled={value >= max}
        onClick={() => onChange(value + 1)}
        aria-label={t("calibration:page.aria.gapIncrease")}
        className={STEP_BUTTON}
      >
        +
      </button>
    </div>
  );
}
