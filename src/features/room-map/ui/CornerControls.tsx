import { useTranslation } from "react-i18next";

import { IconButton } from "@/shared/ui/IconButton/IconButton";
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

/** The top-right corner over either face: in Edit, history, zoom and the keys in one capsule, and
 *  the room-aware pill at the end in both, so it stays put across a switch. */
export function CornerControls({ roomAware, edit }: { roomAware: RoomAwareStatus | null; edit?: CornerEditControls }) {
  const { t } = useTranslation();
  const mod = IS_MAC ? "⌘" : "Ctrl+";
  const shift = IS_MAC ? "⇧" : "Shift+";
  if (!edit && !roomAware) return null;
  return (
    <div className={styles.corner}>
      {edit && (
        <div className={styles.capsule}>
          <IconButton
            className={styles.button}
            aria-disabled={!edit.canUndo}
            onClick={edit.canUndo ? edit.onUndo : undefined}
            label={t("roomMap:toolbar.undo")}
            title={`${t("roomMap:toolbar.undo")} (${mod}Z)`}
            icon={<IconUndo />}
          />
          <IconButton
            className={styles.button}
            aria-disabled={!edit.canRedo}
            onClick={edit.canRedo ? edit.onRedo : undefined}
            label={t("roomMap:toolbar.redo")}
            title={`${t("roomMap:toolbar.redo")} (${mod}${shift}Z)`}
            icon={<IconRedo />}
          />
          <span className={styles.rule} aria-hidden="true" />
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
          <span className={styles.rule} aria-hidden="true" />
          <ShortcutsHelp buttonClassName={styles.button} />
        </div>
      )}
      {roomAware && <RoomAwareIndicator variant="popover" status={roomAware} />}
    </div>
  );
}
