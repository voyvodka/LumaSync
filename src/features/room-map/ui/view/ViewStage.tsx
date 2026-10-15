import { type KeyboardEvent, useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { LampFamily } from "@/features/room-view/model/lampFamily";
import type { CameraCommand } from "@/features/room-view/ui/RoomView3D";
import { RoomView3DHost } from "@/features/room-view/ui/RoomView3DHost";

import { deriveHueAreaState } from "../../model/hueAreaState";
import { parseObjectId } from "../../model/objectId";
import type { RoomAwareStatus } from "../../model/roomAware";
import { buildViewLights, resolveViewSelection } from "../../model/viewLights";
import { useHueIdentify } from "../../state/useHueIdentify";
import type { RoomMapDocument } from "../../state/useRoomMapDocument";
import { useUsbStripStatus } from "../../state/useUsbStripStatus";
import { CornerControls } from "../CornerControls";
import { ROOM_MAP_FIT_INSETS } from "../dock/dockGeometry";
import { RoomViewDock } from "./RoomViewDock";

export interface ViewStageProps {
  doc: RoomMapDocument;
  lampFamilies: ReadonlyMap<number, LampFamily>;
  roomAware: RoomAwareStatus | null;
  hueReachable?: boolean;
  hueStreaming?: boolean;
  /** Opens the plan with what is selected. */
  onEdit: () => void;
  onNavigateToDevices?: () => void;
  onFail: (error: unknown) => void;
}

/** The View face: the room in 3D, its lights in the dock, and the selection the plan shares. A
 *  light picked in the room or in the dock is the same selection, so Edit opens on it. */
export function ViewStage({
  doc,
  lampFamilies,
  roomAware,
  hueReachable,
  hueStreaming = false,
  onEdit,
  onNavigateToDevices,
  onFail,
}: ViewStageProps) {
  const { t } = useTranslation();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [cameraCommand, setCameraCommand] = useState<CameraCommand | undefined>(undefined);
  const { scopedConfig, selectedId, select, selectHueZone, hue, hueAreaId, hueBridgeConfigured, hueBridgeIp } = doc;
  const { stripStatus } = useUsbStripStatus(hueReachable);
  const identify = useHueIdentify(hueBridgeIp);

  const zones = useMemo(
    () => (hueAreaId ? scopedConfig.zones.filter((zone) => zone.entertainmentAreaId === hueAreaId) : scopedConfig.zones),
    [scopedConfig.zones, hueAreaId],
  );
  const lights = useMemo(
    () =>
      buildViewLights(
        { config: scopedConfig, zones, areaChannels: hue.areaChannels, liveChannelIds: hue.liveChannelIds, families: lampFamilies },
        t,
      ),
    [scopedConfig, zones, hue.areaChannels, hue.liveChannelIds, lampFamilies, t],
  );
  const viewSelectedId = resolveViewSelection(scopedConfig, selectedId);
  const selected = lights.find((light) => light.id === viewSelectedId) ?? null;
  const hasHue = hueBridgeConfigured || !!hueAreaId || scopedConfig.hueChannels.length > 0;

  const focusStage = useCallback(() => rootRef.current?.focus({ preventScroll: true }), []);
  // A light is picked over no zone: one left active from Edit would dim every light outside it there.
  const selectLight = useCallback(
    (id: string) => {
      select(id);
      selectHueZone(null);
    },
    [select, selectHueZone],
  );

  // A piece of furniture is not something View can show, so a click on one reads as the ground.
  const handlePick = useCallback(
    (objectId: string | null) => {
      const ref = objectId ? parseObjectId(objectId) : null;
      if (objectId && ref && (ref.kind === "hue" || ref.kind === "tv" || ref.kind === "usb")) selectLight(objectId);
      // A piece of furniture is not empty ground: a click on the sofa kept nothing and dropped the light.
      else if (objectId === null && viewSelectedId !== null) select(null);
      // OrbitControls takes the press, so the root is focused here for Esc to reach it.
      focusStage();
    },
    [select, selectLight, viewSelectedId, focusStage],
  );

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || event.target !== event.currentTarget || viewSelectedId === null) return;
    event.preventDefault();
    select(null);
  };

  return (
    <div ref={rootRef} className="relative h-full outline-none" tabIndex={-1} onKeyDown={onKeyDown}>
      <RoomView3DHost
        config={scopedConfig}
        lampFamilies={lampFamilies}
        label={t("roomMap:face.viewLabel")}
        selectedId={viewSelectedId}
        bottomInset={ROOM_MAP_FIT_INSETS.bottom}
        cameraCommand={cameraCommand}
        onPick={handlePick}
        onFail={onFail}
      />
      <RoomViewDock
        lights={lights}
        hue={
          hasHue
            ? {
                state: deriveHueAreaState(hueBridgeConfigured, hueAreaId),
                zoneCount: zones.length,
                channelsStatus: hue.channelsStatus,
                refreshing: hue.isLoadingChannels,
                onRefresh: hue.refreshChannels,
                onNavigateToDevices,
              }
            : null
        }
        selected={selected}
        strips={scopedConfig.usbStrips}
        stripStatus={stripStatus}
        identify={identify}
        canIdentify={hueBridgeConfigured && hueBridgeIp !== null}
        hueStreaming={hueStreaming}
        onSelect={selectLight}
        onBack={() => select(null)}
        onEdit={(id) => {
          selectLight(id);
          onEdit();
        }}
        onFocusStage={focusStage}
      />
      <CornerControls
        roomAware={roomAware}
        view={{
          onZoomIn: () => setCameraCommand((c) => ({ kind: "in", seq: (c?.seq ?? 0) + 1 })),
          onZoomOut: () => setCameraCommand((c) => ({ kind: "out", seq: (c?.seq ?? 0) + 1 })),
          onReset: () => setCameraCommand((c) => ({ kind: "reset", seq: (c?.seq ?? 0) + 1 })),
        }}
      />
    </div>
  );
}
