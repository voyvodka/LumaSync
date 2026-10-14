import type {
  FurniturePlacement,
  HueChannelPlacement,
  HueZone,
  ImageLayer,
  RoomMapConfig,
  TvAnchorPlacement,
  UsbStripPlacement,
} from "@/shared/contracts/roomMap";
import { autoScreenKind, classifyFurniture } from "@/features/room-view/model/furnitureModel";

import { hueChannelZRange, resolveHueChannelWorld, resolveHueChannelWorldZ } from "../../model/hueChannelPosition";
import { furnitureObjectId, hueChannelObjectId, imageLayerObjectId, TV_ANCHOR_OBJECT_ID, usbStripObjectId } from "../../model/objectId";
import type { InspectorTarget } from "../../model/resolveInspectorTarget";
import { FurnitureInspector } from "../objects/FurnitureInspector";
import { HueChannelInspector } from "../objects/HueChannelInspector";
import { HueZoneInspector } from "../objects/HueZoneInspector";
import { ImageLayerInspector } from "../objects/ImageLayerInspector";
import { TvAnchorInspector } from "../objects/TvAnchorInspector";
import { type UsbStripConnectionStatus, UsbStripInspector } from "../objects/UsbStripInspector";

/** Everything an inspector can do to the map, by object id where the kind has one. */
export interface InspectorActions {
  onUpdateTvAnchor: (patch: Partial<TvAnchorPlacement>) => void;
  onUpdateFurniture: (id: string, patch: Partial<FurniturePlacement>) => void;
  onUpdateUsbStrip: (stripId: string, patch: Partial<UsbStripPlacement>) => void;
  onUpdateImageLayer: (id: string, patch: Partial<ImageLayer>) => void;
  /** A typed position, in the kind's own units: a strip by its start point, a Hue channel in the cube. */
  onMoveObject: (objectId: string, x: number, y: number) => void;
  onHueChannelHeightChange: (channelIndex: number, worldZ: number) => void;
  onRename: (objectId: string, label: string) => void;
  onToggleLock: (objectId: string) => void;
  onDuplicate: (objectId: string) => void;
  onDelete: (objectId: string) => void;
  onUpdateHueZone: (zoneId: string, patch: Partial<HueZone>) => void;
  onRenameHueZone: (zoneId: string, name: string) => void;
  onDeleteHueZone: (zoneId: string) => void;
  onAssignChannelToZone: (channelIndex: number, zoneId: string | null) => void;
  onManageUsb?: () => void;
}

export interface DockInspectorProps {
  target: Exclude<InspectorTarget, { kind: "empty" }>;
  /** The map with only the shown area's channels. */
  config: RoomMapConfig;
  /** The shown area's zones. */
  zones: readonly HueZone[];
  /** The shown area's channels. */
  channels: readonly HueChannelPlacement[];
  /** The bridge's own view of the area, for light counts. */
  areaChannels: readonly { channelId: number; lightCount: number }[];
  /** Bridge ids the area reports; `null` ⇒ no clean read, so nothing is a ghost. */
  liveChannelIds: ReadonlySet<number> | null;
  /** The strip's port and whether it is the connected one. */
  stripStatus: (strip: UsbStripPlacement) => { status: UsbStripConnectionStatus; port: string | null };
  hueBridgeStatus: UsbStripConnectionStatus;
  /** The 3D room is in this build: model, tone, height and screen kind are offered. */
  modelChoices: boolean;
  actions: InspectorActions;
  onClose: () => void;
}

/** What the selection key is, so an inspector remounts on a new object of the same kind — without
 *  it a field's typed text leaked from one strip to the next. See docs/architecture/room-map.md. */
export function inspectorKey(target: Exclude<InspectorTarget, { kind: "empty" }>): string {
  switch (target.kind) {
    case "hueZone":
      return `hueZone:${target.zone.id}`;
    case "tv":
      return "tv:singleton";
    case "furniture":
      return `furniture:${target.item.id}`;
    case "usb":
      return `usb:${target.strip.stripId}`;
    case "hueChannel":
      return `hueChannel:${target.channel.channelIndex}`;
    case "image":
      return `image:${target.layer.id}`;
  }
}

/** The selection's inspector, wired to the map. */
export function DockInspector({
  target,
  config,
  zones,
  channels,
  areaChannels,
  liveChannelIds,
  stripStatus,
  hueBridgeStatus,
  modelChoices,
  actions,
  onClose,
}: DockInspectorProps) {
  const key = inspectorKey(target);
  switch (target.kind) {
    case "hueZone": {
      const zone = target.zone;
      return (
        <HueZoneInspector
          key={key}
          zone={zone}
          zoneIndex={Math.max(0, zones.findIndex((z) => z.id === zone.id))}
          zones={zones}
          channels={channels}
          roomWidthM={config.dimensions.widthMeters}
          roomDepthM={config.dimensions.depthMeters}
          onUpdate={(patch) => actions.onUpdateHueZone(zone.id, patch)}
          onRename={(name) => actions.onRenameHueZone(zone.id, name)}
          onAssignChannel={actions.onAssignChannelToZone}
          onDelete={() => actions.onDeleteHueZone(zone.id)}
          onClose={onClose}
        />
      );
    }
    case "tv":
      return (
        <TvAnchorInspector
          key={key}
          tv={target.tv}
          roomHeightMeters={config.dimensions.heightMeters}
          autoKind={autoScreenKind(config)}
          modelChoices={modelChoices}
          onUpdate={actions.onUpdateTvAnchor}
          onToggleLock={() => actions.onToggleLock(TV_ANCHOR_OBJECT_ID)}
          onDelete={() => actions.onDelete(TV_ANCHOR_OBJECT_ID)}
          onClose={onClose}
        />
      );
    case "furniture": {
      const item = target.item;
      const id = furnitureObjectId(item.id);
      return (
        <FurnitureInspector
          key={key}
          item={item}
          model={classifyFurniture(config).get(item.id)}
          autoModel={classifyFurniture({
            ...config,
            furniture: config.furniture.map((f) => (f.id === item.id ? { ...f, variant: undefined } : f)),
          }).get(item.id)}
          modelChoices={modelChoices}
          onUpdate={(patch) => actions.onUpdateFurniture(item.id, patch)}
          onRename={(label) => actions.onRename(id, label)}
          onToggleLock={() => actions.onToggleLock(id)}
          onDuplicate={() => actions.onDuplicate(id)}
          onDelete={() => actions.onDelete(id)}
          onClose={onClose}
        />
      );
    }
    case "usb": {
      const strip = target.strip;
      const id = usbStripObjectId(strip.stripId);
      const { status, port } = stripStatus(strip);
      return (
        <UsbStripInspector
          key={key}
          strip={strip}
          connectionStatus={status}
          port={port}
          onUpdate={(patch) => actions.onUpdateUsbStrip(strip.stripId, patch)}
          onMove={(x, y) => actions.onMoveObject(id, x, y)}
          onToggleLock={() => actions.onToggleLock(id)}
          onDuplicate={() => actions.onDuplicate(id)}
          onDelete={() => actions.onDelete(id)}
          onClose={onClose}
          onManage={actions.onManageUsb}
        />
      );
    }
    case "hueChannel": {
      const ch = target.channel;
      const id = hueChannelObjectId(ch.channelIndex);
      return (
        <HueChannelInspector
          key={key}
          channel={ch}
          zones={zones}
          lightCount={ch.channelId == null ? null : (areaChannels.find((c) => c.channelId === ch.channelId)?.lightCount ?? null)}
          isGhost={liveChannelIds != null && ch.channelId != null && !liveChannelIds.has(ch.channelId)}
          bridgeStatus={hueBridgeStatus}
          world={resolveHueChannelWorld(ch, config.zones)}
          worldZ={resolveHueChannelWorldZ(ch, config.zones)}
          heightRange={hueChannelZRange(ch, config.zones)}
          roomWidthMeters={config.dimensions.widthMeters}
          roomDepthMeters={config.dimensions.depthMeters}
          roomHeightMeters={config.dimensions.heightMeters}
          onMove={(x, y) => actions.onMoveObject(id, x, y)}
          onHeightChange={(worldZ) => actions.onHueChannelHeightChange(ch.channelIndex, worldZ)}
          onAssignZone={(zoneId) => actions.onAssignChannelToZone(ch.channelIndex, zoneId)}
          onRename={(label) => actions.onRename(id, label)}
          onToggleLock={() => actions.onToggleLock(id)}
          onClose={onClose}
        />
      );
    }
    case "image": {
      const layer = target.layer;
      const id = imageLayerObjectId(layer.id);
      return (
        <ImageLayerInspector
          key={key}
          layer={layer}
          onUpdate={(patch) => actions.onUpdateImageLayer(layer.id, patch)}
          onRename={(label) => actions.onRename(id, label)}
          onToggleLock={() => actions.onToggleLock(id)}
          onDelete={() => actions.onDelete(id)}
          onClose={onClose}
        />
      );
    }
  }
}
