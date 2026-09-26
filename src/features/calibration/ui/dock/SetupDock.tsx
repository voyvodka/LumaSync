import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import type { LedChipType } from "@/shared/contracts/device";
import type { LedDirection } from "../../model/contracts";
import type { DisplayAspect, LayoutDraft } from "../../model/ledLayout";
import type { StartPoint, StripShape } from "../../model/startPoint";
import { AsyncToggle } from "./AsyncToggle";
import { CommitCapsule } from "./CommitCapsule";
import { StartControl } from "./StartControl";
import { TotalControl } from "./TotalControl";
import styles from "./SetupDock.module.css";

interface SetupDockProps {
  draft: LayoutDraft;
  start: StartPoint;
  display: DisplayAspect;
  knownTotal: number | null;
  chipType: LedChipType;
  testing: boolean;
  testBusy: boolean;
  /** The test itself is starting or stopping (not merely the display switching). */
  testToggling: boolean;
  testDisabled: boolean;
  dirty: boolean;
  canSave: boolean;
  saving: boolean;
  savedFlash: boolean;
  onDistribute: (total: number) => void;
  /** A valid total being typed, for the canvas to preview; null when there is none. */
  onPreview: (total: number | null) => void;
  onSetStart: (start: StartPoint) => void;
  onNudge: (step: 1 | -1) => void;
  onDirection: (direction: LedDirection) => void;
  onTest: () => void;
  onRevert: () => void;
  onSave: () => void;
}

/**
 * The one floating bar under the stage: how many LEDs, where the strip starts, and the actions.
 * Every part keeps a fixed width, so a label or a number changing never moves the others.
 */
export function SetupDock(props: SetupDockProps) {
  const { t } = useTranslation();
  const { draft, start, testing } = props;
  const shape: StripShape = useMemo(() => ({ counts: draft.counts, gap: draft.gap }), [draft.counts, draft.gap]);

  return (
    <div className={styles.dock} role="toolbar" aria-label={t("calibration:setup.dockLabel")}>
      <TotalControl
        draft={draft}
        display={props.display}
        knownTotal={props.knownTotal}
        chipType={props.chipType}
        onDistribute={props.onDistribute}
        onPreview={props.onPreview}
      />
      <span className={styles.separator} aria-hidden />
      <StartControl
        shape={shape}
        start={start}
        onSetStart={props.onSetStart}
        onNudge={props.onNudge}
        onDirection={props.onDirection}
      />
      <span className={styles.separator} aria-hidden />
      <AsyncToggle
        on={testing}
        waiting={props.testToggling}
        busy={props.testBusy}
        disabled={props.testDisabled}
        label={testing ? t("calibration:setup.stop") : t("calibration:setup.test")}
        faces={{
          idle: (
            <>
              <svg viewBox="0 0 24 24" aria-hidden fill="currentColor" className={styles.play}>
                <path d="M8 5l11 7-11 7z" />
              </svg>
              {t("calibration:setup.test")}
            </>
          ),
          on: (
            <>
              <span className={styles.live} aria-hidden />
              {t("calibration:setup.stop")}
            </>
          ),
          starting: t("calibration:setup.starting"),
          stopping: t("calibration:setup.stopping"),
        }}
        onToggle={props.onTest}
      />
      <CommitCapsule
        dirty={props.dirty}
        ready={props.canSave}
        committing={props.saving}
        flash={props.savedFlash}
        labels={{
          commit: t("calibration:overlay.save"),
          committing: t("calibration:overlay.saving"),
          rest: t("calibration:setup.savedState"),
          done: t("calibration:setup.saved"),
          revert: t("calibration:setup.revert"),
          unsaved: t("calibration:setup.unsaved"),
        }}
        onCommit={props.onSave}
        onRevert={props.onRevert}
      />
    </div>
  );
}
