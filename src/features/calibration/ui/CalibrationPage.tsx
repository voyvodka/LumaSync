import { useEffect, useRef, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";

import { PREVIEW_OPEN_FAILURE_COPY } from "@/features/preview/previewOpenFailure";
import type { LedCalibrationConfig } from "../model/contracts";
import {
  edgeOfAnchor,
  endpointOfAnchor,
  type AnchorEdge,
  type AnchorEndpoint,
} from "../model/startAnchor";
import type { CalibrationValidationCode } from "../model/validation";
import { useCalibrationSession } from "../state/useCalibrationSession";
import { LedRoomCanvas } from "./LedRoomCanvas";
import { DISPLAY_OVERLAY_STATUS } from "@/shared/contracts/display";
import { clamp } from "@/shared/lib/math";
import { Callout } from "@/shared/ui/Callout";
import { ConfirmDialog } from "@/shared/ui/ConfirmDialog";
import { Segmented } from "@/shared/ui/Segmented";
import type { TranslationKey } from "@/features/i18n/catalogue";

interface CalibrationPageProps {
  initialConfig?: LedCalibrationConfig;
  onNavigateBack: () => void;
  onSaved: (config: LedCalibrationConfig) => void;
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

export function CalibrationPage({ initialConfig, onNavigateBack, onSaved }: CalibrationPageProps) {
  const { t } = useTranslation();
  const {
    config,
    confirmDiscard,
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
  } = useCalibrationSession({ initialConfig, onNavigateBack, onSaved });

  const { counts, bottomMissing, startAnchor, direction, totalLeds } = config;
  const currentEdge = edgeOfAnchor(startAnchor);
  const currentEndpoint = endpointOfAnchor(startAnchor);
  const endpointOptions: AnchorEndpoint[] =
    currentEdge === "bottom" && bottomMissing > 0
      ? ["start", "gap-right", "gap-left", "end"]
      : ["start", "end"];
  const meterLength = (totalLeds / 60).toFixed(1);
  const powerWatts = (totalLeds * 0.06).toFixed(1); // ~0.06W per LED at medium brightness
  // `aria-disabled`, not `disabled`: a button disabled under the keyboard drops
  // focus to the document, and a switch lasts only as long as the overlay takes.
  const isSwitching = displayTarget.isSwitching;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Error strip */}
      {(testPatternError || previewOpenFailure || displayTarget.blocked || (validationErrors && validationErrors.length > 0)) && (
        <div role="alert" className="shrink-0 mx-4 mt-3 flex flex-col gap-1">
          {displayTarget.blocked && (
            <Callout tone="error" announce={false}>
              {t("calibration:overlay.blockedReason", {
                code: displayTarget.blockedCode ?? DISPLAY_OVERLAY_STATUS.OPEN_FAILED,
                reason: displayTarget.blockedReason ?? t("calibration:overlay.blockedReasonUnknown"),
              })}
            </Callout>
          )}
          {testPatternError && (
            <Callout tone="error" announce={false}>
              {testPatternError}
            </Callout>
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
              <span className="whitespace-nowrap font-mono text-[10px] text-ink-dim">
                {t("calibration:page.lengthAndPower", { meters: meterLength, watts: powerWatts })}
              </span>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={() => void handleOpenPreview()}
                title={t("preview:entry.ledSetupHint")}
                className="inline-flex items-center gap-1.5 rounded-md border border-amber/40 bg-amber/10 px-2.5 py-1.5 text-xs font-medium text-amber transition-colors hover:bg-amber/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber/60"
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
                className="inline-flex items-center gap-1.5 rounded-md border border-line-2 bg-panel px-2.5 py-1.5 text-xs font-medium text-ink transition-colors hover:bg-panel-2"
              >
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8">
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
                className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40 aria-disabled:cursor-not-allowed aria-disabled:opacity-40 ${
                  testPattern.isEnabled
                    ? "bg-amber text-bg hover:bg-amber"
                    : "border border-line-2 bg-panel text-ink hover:bg-panel-2"
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
          <DockSection title={t("calibration:page.dockCaptureSource")}>
            <div className="flex flex-col gap-1.5">
              {displayTarget.displays.length === 0 ? (
                <div className="rounded-md border border-dashed border-line-2 px-3 py-2 text-xs text-ink-dim">
                  {t("calibration:overlay.noDisplays")}
                </div>
              ) : (
                displayTarget.displays.map((display) => {
                  const isSelected = display.id === displayTarget.selectedDisplayId;
                  return (
                    <button
                      key={display.id}
                      type="button"
                      aria-disabled={isSwitching || undefined}
                      onClick={() => void handleSelectDisplay(display)}
                      className={`flex items-center gap-2 rounded-md border px-2.5 py-2 text-left transition-colors aria-disabled:cursor-not-allowed aria-disabled:opacity-40 ${
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

          <DockSection title={t("calibration:page.dockDirection")}>
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
              className="flex-1 rounded-md border border-line-2 px-3 py-1.5 text-xs font-medium text-ink transition-colors hover:bg-panel-2"
            >
              {t("calibration:overlay.cancel")}
            </button>
            <button
              type="button"
              disabled={isSaving}
              aria-busy={isSaving}
              onClick={() => void handleSave()}
              className="flex-1 rounded-md bg-amber px-3 py-1.5 text-xs font-semibold text-bg transition-colors hover:bg-amber disabled:opacity-50"
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
        />
      )}
    </div>
  );
}

function DockSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-2 font-mono text-[9.5px] uppercase tracking-[0.18em] text-ink-dim">
        <span className="h-px w-2.5 bg-line-2" />
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
      <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-ink-dim">{label}</span>
      <span className="font-mono text-sm font-medium text-ink">{value}</span>
      <span className="font-mono text-[9px] uppercase tracking-[0.1em] text-ink-faint">{t("calibration:page.ledUnit")}</span>
    </div>
  );
}

// Number stepper with always-editable keyboard input.
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
    <div className="rounded-md border border-line-2 bg-panel px-2 py-1.5">
      <div className="font-mono text-[9px] uppercase tracking-[0.14em] text-ink-dim">{label}</div>
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
          className="min-w-0 flex-1 bg-transparent border-0 p-0 font-mono text-base font-medium text-ink outline-none focus:underline focus:decoration-amber-400 focus:underline-offset-4"
        />
        <div className="flex flex-col gap-0.5">
          <button
            type="button"
            onClick={() => onChange(value + 1)}
            aria-label={t("calibration:page.aria.countIncrease", { label })}
            className="flex h-4 w-5 items-center justify-center rounded border border-line-2 text-[10px] leading-none text-ink-dim transition-colors hover:border-amber hover:text-amber"
          >
            +
          </button>
          <button
            type="button"
            onClick={() => onChange(value - 1)}
            aria-label={t("calibration:page.aria.countDecrease", { label })}
            className="flex h-4 w-5 items-center justify-center rounded border border-line-2 text-[10px] leading-none text-ink-dim transition-colors hover:border-amber hover:text-amber"
          >
            −
          </button>
        </div>
      </div>
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

/** One option of a dock choice group; `layout` carries what differs between the groups. */
function dockChoiceClass(active: boolean, layout: string): string {
  return `rounded-md border py-1.5 tracking-[0.1em] transition-colors ${layout} ${
    active
      ? "border-amber/40 bg-amber/10 text-amber"
      : "border-line-2 bg-panel text-ink-dim hover:border-line-2"
  }`;
}

// Same keyboard-input pattern as CountStepper, with the
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
    <div className="flex items-center gap-2 rounded-md border border-line-2 bg-panel px-2.5 py-1.5">
      <div className="min-w-0 flex-1">
        <div className="font-mono text-[9px] uppercase tracking-[0.14em] text-ink-dim">
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
          className="w-full bg-transparent border-0 p-0 font-mono text-base font-medium text-ink outline-none focus:underline focus:decoration-amber-400 focus:underline-offset-4"
        />
      </div>
      <div className="font-mono text-[9px] text-ink-faint">/ {max}</div>
      <div className="flex flex-col gap-0.5">
        <button
          type="button"
          disabled={value >= max}
          onClick={() => onChange(value + 1)}
          aria-label={t("calibration:page.aria.gapIncrease")}
          className="flex h-4 w-5 items-center justify-center rounded border border-line-2 text-[10px] leading-none text-ink-dim transition-colors hover:border-amber hover:text-amber disabled:cursor-not-allowed disabled:opacity-35"
        >
          +
        </button>
        <button
          type="button"
          disabled={value <= 0}
          onClick={() => onChange(value - 1)}
          aria-label={t("calibration:page.aria.gapDecrease")}
          className="flex h-4 w-5 items-center justify-center rounded border border-line-2 text-[10px] leading-none text-ink-dim transition-colors hover:border-amber hover:text-amber disabled:cursor-not-allowed disabled:opacity-35"
        >
          −
        </button>
      </div>
    </div>
  );
}
