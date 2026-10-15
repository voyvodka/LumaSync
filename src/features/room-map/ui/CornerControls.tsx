import { useTranslation } from "react-i18next";

import { cx } from "@/shared/lib/cx";
import { IconButton } from "@/shared/ui/IconButton/IconButton";
import { Segmented } from "@/shared/ui/Segmented/Segmented";
import { IconRedo, IconUndo } from "@/shared/ui/icons";

import type { RoomAwareStatus } from "../model/roomAware";
import styles from "./CornerControls.module.css";
import { RoomAwareIndicator } from "./RoomAwareIndicator";
import { ShortcutsHelp } from "./ShortcutsHelp";
import { ZoomControl } from "./ZoomControl";

const IS_MAC = typeof navigator !== "undefined" && navigator.platform.includes("Mac");

export interface CornerEditControls {
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  zoom: number;
  canvasSize: { w: number; h: number };
  panOffset: { x: number; y: number };
  /** The middle of what the chrome leaves free, which a zoom step keeps still. */
  anchor: { x: number; y: number };
  onZoomChange: (zoom: number) => void;
  onPanChange: (pan: { x: number; y: number }) => void;
  onFitToView: () => void;
}

/** The editor's history alone, for the 3D stage, where the plan's zoom means nothing. */
export type CornerHistoryControls = Pick<CornerEditControls, "canUndo" | "canRedo" | "onUndo" | "onRedo">;

export const EDIT_STAGES = { ROOM: "room", PLAN: "plan" } as const;
export type EditStage = (typeof EDIT_STAGES)[keyof typeof EDIT_STAGES];

/** What the editor draws the room as: the 3D room or the plan. */
export interface CornerStageControls {
  value: EditStage;
  onChange: (stage: EditStage) => void;
}

/** The 3D view's camera: closer, further, and back to the whole room. */
export interface CornerViewControls {
  onZoomIn: () => void;
  onZoomOut: () => void;
  onReset: () => void;
}

/** The top-right corner over either face: in Edit, the stage, then history, zoom and the keys in
 *  one capsule; in View, the camera's; the room-aware pill at the end in both, so it stays put
 *  across a switch. Editing in 3D puts the camera in the zoom's slot, which keeps one width, so the
 *  stage switch and undo stay under the pointer when the stage changes. */
export function CornerControls({
  roomAware,
  edit,
  history,
  view,
  stage,
}: {
  roomAware: RoomAwareStatus | null;
  edit?: CornerEditControls;
  history?: CornerHistoryControls;
  view?: CornerViewControls;
  stage?: CornerStageControls;
}) {
  const { t } = useTranslation();
  const mod = IS_MAC ? "⌘" : "Ctrl+";
  const shift = IS_MAC ? "⇧" : "Shift+";
  if (!edit && !history && !view && !stage && !roomAware) return null;
  const steps = edit ?? history;
  return (
    <div className={styles.corner}>
      {stage && (
        <Segmented
          className={styles.capsule}
          itemClassName={cx(styles.button, styles.stage)}
          ariaLabel={t("roomMap:stage.label")}
          value={stage.value}
          onChange={stage.onChange}
          options={[
            { value: EDIT_STAGES.ROOM, label: t("roomMap:stage.room"), testId: "room-edit-stage-room" },
            { value: EDIT_STAGES.PLAN, label: t("roomMap:stage.plan"), testId: "room-edit-stage-plan" },
          ]}
        />
      )}
      {view && !steps && (
        <div className={styles.capsule}>
          <CameraButtons view={view} />
        </div>
      )}
      {steps && (
        <div className={styles.capsule}>
          <IconButton
            className={styles.button}
            aria-disabled={!steps.canUndo}
            onClick={steps.canUndo ? steps.onUndo : undefined}
            label={t("roomMap:toolbar.undo")}
            title={`${t("roomMap:toolbar.undo")} (${mod}Z)`}
            icon={<IconUndo />}
          />
          <IconButton
            className={styles.button}
            aria-disabled={!steps.canRedo}
            onClick={steps.canRedo ? steps.onRedo : undefined}
            label={t("roomMap:toolbar.redo")}
            title={`${t("roomMap:toolbar.redo")} (${mod}${shift}Z)`}
            icon={<IconRedo />}
          />
          <span className={styles.rule} aria-hidden="true" />
          {(edit || view) && (
            <>
              <div className={styles.slot}>
                {edit ? (
                  <ZoomControl
                    className={styles.group}
                    buttonClassName={styles.button}
                    zoom={edit.zoom}
                    canvasSize={edit.canvasSize}
                    panOffset={edit.panOffset}
                    anchor={edit.anchor}
                    onZoomChange={edit.onZoomChange}
                    onPanChange={edit.onPanChange}
                    onFitToView={edit.onFitToView}
                    isMac={IS_MAC}
                  />
                ) : (
                  view && <CameraButtons view={view} />
                )}
              </div>
              <span className={styles.rule} aria-hidden="true" />
            </>
          )}
          <ShortcutsHelp buttonClassName={styles.button} room={!edit} />
        </div>
      )}
      {roomAware && <RoomAwareIndicator variant="popover" status={roomAware} />}
    </div>
  );
}

function CameraButtons({ view }: { view: CornerViewControls }) {
  const { t } = useTranslation();
  return (
    <>
      <IconButton className={styles.button} label={t("roomMap:zoomControl.out")} icon="−" onClick={view.onZoomOut} />
      <IconButton className={styles.button} label={t("roomMap:zoomControl.in")} icon="+" onClick={view.onZoomIn} />
      <span className={styles.rule} aria-hidden="true" />
      <IconButton
        className={styles.button}
        label={t("roomMap:view.resetCamera")}
        title={t("roomMap:view.cameraHint")}
        icon={<IconResetView />}
        onClick={view.onReset}
        data-testid="view-reset-camera"
      />
    </>
  );
}

function IconResetView() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <path d="M2.5 6V2.5H6M13.5 6V2.5H10M2.5 10v3.5H6M13.5 10v3.5H10" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
