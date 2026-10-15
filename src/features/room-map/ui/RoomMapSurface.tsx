import { type CSSProperties, useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

import type { HueProbeVerdict } from "@/features/hue/state/useHueBridgeReachability";
import { ROOM_VIEW_3D_AVAILABLE } from "@/features/room-view/ui/RoomView3DHost";
import type { HueRuntimeTarget } from "@/shared/contracts/hue";
import type { RoomMapConfig } from "@/shared/contracts/roomMap";
import { cx } from "@/shared/lib/cx";
import { Segmented } from "@/shared/ui/Segmented/Segmented";

import { roomAwareStatus } from "../model/roomAware";
import { applyRoomTemplate, isRoomMapEmpty } from "../model/roomTemplate";
import { useHueLampFamilies } from "../state/useHueLampFamilies";
import { useRoomMapDocument } from "../state/useRoomMapDocument";
import { RoomMapEditor } from "./RoomMapEditor";
import styles from "./RoomMapSurface.module.css";
import { TemplateSelector } from "./TemplateSelector";
import { ViewStage } from "./view/ViewStage";

export const ROOM_FACES = { VIEW: "view", EDIT: "edit" } as const;
export type RoomFace = (typeof ROOM_FACES)[keyof typeof ROOM_FACES];

// A WebGL failure belongs to the machine, not the moment, so the 3D face is not offered again
// until the app restarts.
let viewFailed = false;

/** Test seam — the failure is remembered for the session. */
export function __resetRoomViewFailure(): void {
  viewFailed = false;
}

export interface RoomMapSurfaceProps {
  /** Opens Devices, where a bridge is paired and an area picked. */
  onNavigateToDevices?: () => void;
  /** App-level Hue reachability; `undefined` renders no connection chips. */
  hueReachable?: boolean;
  /** Selected outputs; with a TV anchor, a Hue target turns the room-aware chip on. */
  outputTargets?: HueRuntimeTarget[];
  /** A bridge is paired. Without one the room-aware chip stays hidden. */
  hueConfigured?: boolean;
  /** Picks the paused room-aware chip's reason, as it does the Lights Hue row's. */
  hueProbeVerdict?: HueProbeVerdict | null;
  /** Whether this build carries the 3D room; a prop so a test can take either branch. */
  view3dAvailable?: boolean;
}

/**
 * The room map: the room in 3D (View) and its plan (Edit) over one slot, switched from the same
 * spot in both. The map, its history and its Hue area live here, so a switch keeps undo, the
 * selection and a pending save, while the face left behind unmounts — the plan does not keep
 * rendering under the room, and the room hands its WebGL context back. A build without the 3D
 * room shows the plan alone, with no switch.
 */
export function RoomMapSurface({
  onNavigateToDevices,
  hueReachable,
  outputTargets = [],
  hueConfigured = false,
  hueProbeVerdict = null,
  view3dAvailable = ROOM_VIEW_3D_AVAILABLE,
}: RoomMapSurfaceProps) {
  const { t } = useTranslation();
  const doc = useRoomMapDocument();
  const { config, replace } = doc;
  const [failed, setFailed] = useState(viewFailed);
  // Not stored: the map always opens on the room, and Edit is a step into it.
  const [face, setFace] = useState<RoomFace>(view3dAvailable && !viewFailed ? ROOM_FACES.VIEW : ROOM_FACES.EDIT);
  // The first face appears as the map opens; only a switch fades one in.
  const [switched, setSwitched] = useState(false);
  // Edit opened from the light card takes the keys, or they would fall to the page with the card.
  const [editTakesFocus, setEditTakesFocus] = useState(false);
  const lampFamilies = useHueLampFamilies(doc.hue.areaChannels, face === ROOM_FACES.VIEW);

  const handleFace = useCallback((next: RoomFace) => {
    setSwitched(true);
    setEditTakesFocus(false);
    setFace(next);
  }, []);

  const handleViewFail = useCallback((error: unknown) => {
    console.error("[LumaSync] room 3D view failed to open:", error);
    viewFailed = true;
    setFailed(true);
    setFace(ROOM_FACES.EDIT);
  }, []);

  const handleTemplateSelect = useCallback(
    (template: RoomMapConfig) => replace(applyRoomTemplate(config, template)),
    [config, replace],
  );

  if (doc.loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <span className="text-sm text-ink-faint">{t("roomMap:loading")}</span>
      </div>
    );
  }

  // An empty map with no edit history opens on the templates, in either face.
  if (isRoomMapEmpty(config) && !doc.canUndo) {
    return <TemplateSelector onSelect={handleTemplateSelect} />;
  }

  const roomAware = roomAwareStatus(config.tvAnchor, outputTargets, {
    configured: hueConfigured,
    reachable: hueReachable ?? false,
    verdict: hueProbeVerdict,
  });

  return (
    <div className={styles.surface}>
      {view3dAvailable && <FaceSwitch face={face} viewFailed={failed} onChange={handleFace} />}
      <div key={face} className={cx(styles.face, switched && styles.arriving)} data-testid={`room-face-${face}`}>
        {face === ROOM_FACES.VIEW ? (
          <ViewStage
            doc={doc}
            lampFamilies={lampFamilies}
            roomAware={roomAware}
            hueReachable={hueReachable}
            onEdit={() => {
              handleFace(ROOM_FACES.EDIT);
              setEditTakesFocus(true);
            }}
            onNavigateToDevices={onNavigateToDevices}
            onFail={handleViewFail}
          />
        ) : (
          <RoomMapEditor
            doc={doc}
            onNavigateToDevices={onNavigateToDevices}
            hueReachable={hueReachable}
            roomAware={roomAware}
            focusOnMount={editTakesFocus}
          />
        )}
      </div>
    </div>
  );
}

function FaceSwitch({
  face,
  viewFailed,
  onChange,
}: {
  face: RoomFace;
  viewFailed: boolean;
  onChange: (face: RoomFace) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className={styles.switch} style={{ "--i": face === ROOM_FACES.VIEW ? 0 : 1 } as CSSProperties}>
      <span className={styles.mark} aria-hidden="true" />
      <Segmented
        className={styles.group}
        itemClassName={styles.item}
        ariaLabel={t("roomMap:face.label")}
        value={face}
        onChange={onChange}
        options={[
          {
            value: ROOM_FACES.VIEW,
            label: t("roomMap:face.view"),
            disabled: viewFailed,
            title: viewFailed ? t("roomMap:face.viewUnavailable") : undefined,
            ariaLabel: viewFailed ? t("roomMap:face.viewUnavailable") : undefined,
            testId: "room-face-switch-view",
          },
          { value: ROOM_FACES.EDIT, label: t("roomMap:face.edit"), testId: "room-face-switch-edit" },
        ]}
      />
    </div>
  );
}
