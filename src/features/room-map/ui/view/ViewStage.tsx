import { type KeyboardEvent, useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { LampFamily } from "@/features/room-view/model/lampFamily";
import type { CameraCommand } from "@/features/room-view/ui/RoomView3D";
import { RoomView3DHost } from "@/features/room-view/ui/RoomView3DHost";
import { hexCss } from "@/features/room-view/model/roomMood";

import { deriveHueAreaState } from "../../model/hueAreaState";
import { driveDecorWithHue } from "../../model/decorLight";
import { hueChannelObjectId, parseObjectId } from "../../model/objectId";
import type { RoomAwareStatus } from "../../model/roomAware";
import { buildViewLights, resolveViewSelection } from "../../model/viewLights";
import { useHoverChip } from "../../state/useHoverChip";
import { useHueIdentify } from "../../state/useHueIdentify";
import { useRoomMood } from "../../state/useRoomMood";
import { useStripBlink } from "../../state/useStripBlink";
import type { RoomMapDocument } from "../../state/useRoomMapDocument";
import { useUsbStripStatus } from "../../state/useUsbStripStatus";
import { CornerControls } from "../CornerControls";
import { ROOM_MAP_FIT_INSETS } from "../dock/dockGeometry";
import { HoverChip } from "./HoverChip";
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
  const { stripStatus, hueBridgeStatus } = useUsbStripStatus(hueReachable);
  const identify = useHueIdentify(hueBridgeIp);
  const blink = useStripBlink();
  const mood = useRoomMood();
  const lit = useMemo(() => {
    if (mood.level <= 0) return null;
    const stops = mood.palette?.map(hexCss);
    return stops?.[0]
      ? { colour: stops[0], brightness: mood.brightness, fill: `conic-gradient(${[...stops, stops[0]].join(", ")})` }
      : { colour: hexCss(mood.lamp), brightness: mood.brightness };
  }, [mood]);

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

  const { hoveredId, onHover: handleHover, chipRef } = useHoverChip(rootRef);
  const hovered = hoveredId ? lights.find((light) => light.id === hoveredId) ?? null : null;
  // A light is picked over no zone: one left active from Edit would dim every light outside it there.
  const selectLight = useCallback(
    (id: string) => {
      select(id);
      selectHueZone(null);
    },
    [select, selectHueZone],
  );

  // View looks and picks lights; pieces are moved in Edit, so a click on one keeps the light.
  const handlePick = useCallback(
    (objectId: string | null) => {
      const ref = objectId ? parseObjectId(objectId) : null;
      const decor = ref?.kind === "decor" && lights.some((light) => light.id === objectId);
      if (objectId && ref && (ref.kind === "hue" || decor || ref.kind === "tv" || ref.kind === "usb")) selectLight(objectId);
      else if (objectId === null && (viewSelectedId !== null || selectedId !== null)) select(null);
      // OrbitControls takes the press, so the root is focused here for Esc to reach it.
      focusStage();
    },
    [select, selectLight, viewSelectedId, selectedId, focusStage, lights],
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
        topInset={ROOM_MAP_FIT_INSETS.top}
        cameraCommand={cameraCommand}
        mood={mood}
        onPick={handlePick}
        onHover={handleHover}
        onFail={onFail}
      />
      {hovered && (
        <HoverChip
          chipRef={chipRef}
          name={hovered.name}
          lit={mood.level > 0}
          level={hovered.kind === "decor" ? undefined : mood.brightness}
        />
      )}
      <RoomViewDock
        lights={lights}
        hue={
          hasHue
            ? {
                state: deriveHueAreaState(hueBridgeConfigured, hueAreaId),
                zoneCount: zones.length,
                lightCount: lights.filter((light) => light.kind === "hue").length,
                channelsStatus: hue.channelsStatus,
                refreshing: hue.isLoadingChannels,
                onRefresh: hue.refreshChannels,
                onNavigateToDevices,
              }
            : null
        }
        selected={selected}
        strips={scopedConfig.usbStrips}
        tv={scopedConfig.tvAnchor ?? null}
        stripStatus={stripStatus}
        hueBridgeStatus={hueBridgeStatus}
        identify={identify}
        blink={blink}
        level={mood.level > 0 ? mood.brightness : null}
        canIdentify={hueBridgeConfigured && hueBridgeIp !== null}
        hueStreaming={hueStreaming}
        lit={lit}
        channels={doc.visibleHueChannels}
        onSelect={selectLight}
        onBack={() => select(null)}
        onEdit={(id) => {
          selectLight(id);
          onEdit();
        }}
        onDrive={(id, channelIndex) => {
          const ref = parseObjectId(id);
          const channel = doc.visibleHueChannels.find((ch) => ch.channelIndex === channelIndex);
          const next = ref?.kind === "decor" && channel ? driveDecorWithHue(doc.config, ref.structureId, channel) : null;
          if (!next) return;
          doc.apply(next);
          selectLight(hueChannelObjectId(channelIndex));
        }}
        onFocusStage={focusStage}
      />
      <CornerControls
        roomAware={roomAware}
        daylight
        lights
        view={{
          onZoomIn: () => setCameraCommand((c) => ({ kind: "in", seq: (c?.seq ?? 0) + 1 })),
          onZoomOut: () => setCameraCommand((c) => ({ kind: "out", seq: (c?.seq ?? 0) + 1 })),
          onReset: () => setCameraCommand((c) => ({ kind: "reset", seq: (c?.seq ?? 0) + 1 })),
        }}
      />
    </div>
  );
}
