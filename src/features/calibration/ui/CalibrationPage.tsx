import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { PREVIEW_OPEN_FAILURE_COPY } from "@/features/preview/previewOpenFailure";
import type { LeaveGuard } from "@/features/shell/navigationStore";
import type { LedCalibrationConfig } from "../model/contracts";
import type { CalibrationNotice } from "../model/calibrationNotices";
import { distribute, maxTotal, minTotal } from "../model/ledLayout";
import type { CalibrationValidationCode } from "../model/validation";
import { draftOf, startOf } from "../state/layoutEdit";
import { useCalibrationSession } from "../state/useCalibrationSession";
import { FirstRunCard } from "./FirstRunCard";
import { SetupTopBar } from "./top/SetupTopBar";
import styles from "./CalibrationPage.module.css";
import { SetupDock } from "./dock/SetupDock";
import { SetupStage } from "./SetupStage";
import { Callout } from "@/shared/ui/Callout";
import { ConfirmDialog } from "@/shared/ui/ConfirmDialog";

interface CalibrationPageProps {
  initialConfig?: LedCalibrationConfig;
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
  BOTTOM_GAP_NEEDS_TWO_LEDS: "calibration:page.validation.BOTTOM_GAP_NEEDS_TWO_LEDS",
  NO_LEDS_CONFIGURED: "calibration:page.validation.NO_LEDS_CONFIGURED",
  // `satisfies`, not an annotation: `t()` needs the literal types, and this
  // still fails to compile if a code is added to the union without a string.
} as const satisfies Record<CalibrationValidationCode, string>;

export function CalibrationPage({
  initialConfig,
  onNavigateBack,
  onSaved,
  registerLeaveGuard,
}: CalibrationPageProps) {
  const { t } = useTranslation();
  const session = useCalibrationSession({ initialConfig, onNavigateBack, onSaved, registerLeaveGuard });
  const {
    config,
    isDirty,
    confirmDiscard,
    firstRun,
    canSave,
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
  } = session;

  const [savedFlash, setSavedFlash] = useState(false);
  useEffect(() => {
    if (lastSavedAt === null) return;
    setSavedFlash(true);
    const timer = setTimeout(() => setSavedFlash(false), 1800);
    return () => clearTimeout(timer);
  }, [lastSavedAt]);

  const start = useMemo(() => startOf(config), [config]);
  const draft = useMemo(() => draftOf(config, layoutUi), [config, layoutUi]);
  const selectedDisplay = displayTarget.displays.find((d) => d.id === displayTarget.selectedDisplayId);
  const displayW = selectedDisplay?.width ?? 16;
  const displayH = selectedDisplay?.height ?? 9;
  const display = useMemo(() => ({ width: displayW, height: displayH }), [displayW, displayH]);
  // A total being typed: the canvas shows the split it would make, nothing is applied yet.
  const [previewTotal, setPreviewTotal] = useState<number | null>(null);
  const previewDraft = useMemo(
    () => (previewTotal === null ? null : distribute(draft, previewTotal, display)),
    [previewTotal, draft, display],
  );

  // `aria-disabled`, not `disabled`: a button disabled under the keyboard drops
  // focus to the document, and a switch lasts only as long as the overlay takes.
  // A test pattern start or stop holds both too; the session ignores a press then.
  const isSwitching = displayTarget.isSwitching || isTogglingTestPattern;

  const notices = [
    overlayBlocked && <NoticeCallout key="overlay" notice={overlayBlocked} />,
    testPatternError && <NoticeCallout key="test" notice={testPatternError} />,
    saveError && (
      <NoticeCallout
        key="save"
        notice={saveError}
        action={{ label: t("calibration:overlay.retrySave"), onClick: () => void session.handleSave(), pending: isSaving }}
      />
    ),
    previewOpenFailure && (
      <Callout key="preview" tone="error" announce={false}>
        {t(PREVIEW_OPEN_FAILURE_COPY[previewOpenFailure])}
      </Callout>
    ),
    ...(validationErrors ?? []).map((error) => (
      <Callout key={`${error.code}:${error.field}`} tone="error" announce={false}>
        {t(VALIDATION_MESSAGE_KEYS[error.code], { field: error.field })}
      </Callout>
    )),
  ].filter(Boolean);

  return (
    <div className={styles.page}>
      <SetupTopBar
        displays={displayTarget.displays}
        selectedDisplayId={displayTarget.selectedDisplayId}
        switching={isSwitching}
        onSelectDisplay={(d) => void session.handleSelectDisplay(d)}
        testTarget={testPattern.isEnabled ? (testPattern.mode === "preview-only" ? "preview" : "strip") : null}
        previewDisabled={firstRun}
        onPreview={() => void session.handleOpenPreview()}
      />

      {(notices.length > 0 || testLayoutStale) && (
        <div className={styles.notices}>
          {notices.length > 0 && <div role="alert" className="flex flex-col gap-1">{notices}</div>}
          {testLayoutStale && (
            <Callout tone={draftTestable ? "info" : "warning"} testId="calibration-test-stale">
              {draftTestable ? t("calibration:page.testUpdating") : t("calibration:page.testKeepsLastValid")}
            </Callout>
          )}
        </div>
      )}

      <SetupStage
        draft={draft}
        start={start}
        display={display}
        empty={firstRun}
        preview={previewDraft}
        onCount={session.handleCountChange}
        onEdgeToggle={session.handleEdgeToggle}
        onStandToggle={session.handleStandToggle}
        onChain={session.handleChainToggle}
        onPickLed={session.handlePickLed}
        onPickCorner={session.handlePickCorner}
        onPickEnd={session.handlePickEnd}
      >
        {firstRun && (
          <FirstRunCard
            knownTotal={knownTotal}
            floor={minTotal(draft)}
            ceiling={maxTotal(draft, display)}
            onDistribute={session.handleDistribute}
            onSkip={session.handleSkipTotal}
          />
        )}
      </SetupStage>

      {!firstRun && (
        <SetupDock
          draft={draft}
          start={start}
          display={display}
          knownTotal={knownTotal}
          chipType={chipType}
          testing={testPattern.isEnabled}
          testBusy={isSwitching}
          testToggling={isTogglingTestPattern}
          testDisabled={displayTarget.displays.length === 0}
          dirty={isDirty}
          canSave={canSave}
          saving={isSaving}
          savedFlash={savedFlash}
          onDistribute={session.handleDistribute}
          onPreview={setPreviewTotal}
          onSetStart={session.handleSetStart}
          onNudge={session.handleNudge}
          onDirection={session.handleDirectionChange}
          onTest={() => void session.handlePreviewToggle()}
          onRevert={session.handleRevert}
          onSave={() => void session.handleSave()}
        />
      )}

      {/* Escape means "keep editing" — the safe answer for a dialog whose other
          option throws work away. */}
      {confirmDiscard && (
        <ConfirmDialog
          tone="danger"
          title={t("calibration:overlay.unsavedTitle")}
          body={t("calibration:overlay.unsavedDescription")}
          cancelLabel={t("calibration:overlay.keepEditing")}
          confirmLabel={t("calibration:overlay.discard")}
          onCancel={session.handleKeepEditing}
          onConfirm={session.handleDiscard}
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
