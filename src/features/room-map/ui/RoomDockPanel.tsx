// Channel-under-zone grouping here is presentation only — `zoneId` is the join
// key on disk. Dock rationale: docs/architecture/room-map.md.
import { useState } from "react";
import { useTranslation } from "react-i18next";

import type {
  FurniturePlacement,
  HueZone,
  ImageLayer,
  RoomMapConfig,
  TvAnchorPlacement,
  UsbStripPlacement,
} from "@/shared/contracts/roomMap";
import { HueZoneInspector } from "./HueZoneInspector";
import { HueZonesTab } from "./HueZonesTab";
import { ObjectsTab } from "./ObjectsTab";
import { FurnitureInspector } from "./objects/FurnitureInspector";
import { HueChannelInspector } from "./objects/HueChannelInspector";
import { ImageLayerInspector } from "./objects/ImageLayerInspector";
import { TvAnchorInspector } from "./objects/TvAnchorInspector";
import {
  UsbStripInspector,
  type UsbStripConnectionStatus,
} from "./objects/UsbStripInspector";
import { resolveInspectorTarget } from "../model/resolveInspectorTarget";
import {
  furnitureObjectId,
  hueChannelObjectId,
  imageLayerObjectId,
  usbStripObjectId,
} from "../model/objectId";

type DockTab = "objects" | "hueZones";

interface RoomDockPanelProps {
  config: RoomMapConfig;

  // Object selection (any draggable item on the canvas)
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onDelete: (id: string) => void;
  onRenameFurniture: (id: string, label: string) => void;
  onToggleLock: (id: string) => void;

  // Hue zones (v1.5 W4-F2 — sole surviving zone kind, spatial 3D Hue
  // Entertainment Area subset). Logical zones were dropped; the dock no
  // longer renders a Zones tab.
  hueZones?: HueZone[];
  activeHueZoneId?: string | null;
  onSelectHueZone?: (zoneId: string | null) => void;
  onAddHueZone?: () => void;
  onDeleteHueZone?: (zoneId: string) => void;
  onRenameHueZone?: (zoneId: string, name: string) => void;
  onUpdateHueZone?: (zoneId: string, patch: Partial<HueZone>) => void;
  /** When true, "+ Hue zone" CTA is disabled (no entertainment area paired). */
  addHueZoneDisabled?: boolean;
  addHueZoneDisabledTooltip?: string;
  // ── Wave 4-B props ────────────────────────────────────────────────
  /** True when a Hue bridge is paired (legacy plaintext or keychain). */
  hueBridgeConfigured?: boolean;
  /** Persisted entertainment area id; null when no area picked. */
  hueAreaId?: string | null;
  /**
   * B2/B3 — move a single channel between zones (or detach when target is
   * `null`). Powers the row drag handle, "Unassigned" drop bucket, and the
   * inline "Move to →" popover. Inert when omitted, so the dock degrades
   * to the v1.5 read-only flow.
   */
  onAssignChannelToZone?: (channelIndex: number, targetZoneId: string | null) => void;
  /**
   * B1 — emitted when the state strip CTA prompts the user to finish Hue
   * onboarding. Inert when omitted (CTA still renders for clarity but
   * does nothing on click).
   */
  onNavigateToDevices?: () => void;

  // Every inspector callback is optional on purpose: a read-only embed still
  // renders the inspector, with the affected control disabled.
  /** Patch a furniture placement by id (rotation, type, w/h). */
  onUpdateFurniture?: (id: string, patch: Partial<FurniturePlacement>) => void;
  /** Patch the TV anchor (single instance, no id). */
  onUpdateTvAnchor?: (patch: Partial<TvAnchorPlacement>) => void;
  /** Patch a USB strip placement by stripId (LED count primarily). */
  onUpdateUsbStrip?: (stripId: string, patch: Partial<UsbStripPlacement>) => void;
  /** Patch an image layer by id (opacity edits from the inspector). */
  onUpdateImageLayer?: (id: string, patch: Partial<ImageLayer>) => void;
  /** Rename a Hue channel by index. */
  onRenameHueChannel?: (channelIndex: number, label: string) => void;
  /** Rename an image layer by id. */
  onRenameImageLayer?: (id: string, label: string) => void;

  /**
   * Currently bound USB port name; null when nothing is connected.
   * Drives the connection chip rendered in `UsbStripInspector`.
   */
  usbConnectedPort?: string | null;
  /**
   * Resolved connection status for USB strips. The dock does not own
   * the snapshot (`useUsbConnectionStatus` does); it just renders.
   */
  usbConnectionStatus?: UsbStripConnectionStatus;
  /** Drop the active USB connection (Disconnect button in inspector). */
  onUsbManage?: () => void;

  /**
   * App-level Hue reachability, forwarded so `HueChannelInspector` uses the same
   * chip vocabulary as the USB strip inspector. `unknown` ⇒ no chip rendered.
   */
  hueChannelStatus?: UsbStripConnectionStatus;
}

/* ── main panel ─────────────────────────────────────────────────── */

export function RoomDockPanel(props: RoomDockPanelProps) {
  const {
    config,
    selectedId,
    onSelect,
    onDelete,
    onRenameFurniture,
    onToggleLock,
    hueZones = [],
    activeHueZoneId = null,
    onSelectHueZone,
    onAddHueZone,
    onDeleteHueZone,
    onRenameHueZone,
    onUpdateHueZone,
    addHueZoneDisabled = false,
    addHueZoneDisabledTooltip,
    hueBridgeConfigured = false,
    hueAreaId = null,
    onAssignChannelToZone,
    onNavigateToDevices,
    onUpdateFurniture,
    onUpdateTvAnchor,
    onUpdateUsbStrip,
    onUpdateImageLayer,
    onRenameHueChannel,
    onRenameImageLayer,
    usbConnectedPort = null,
    usbConnectionStatus = "unknown",
    onUsbManage,
    hueChannelStatus = "unknown",
  } = props;
  const { t } = useTranslation();

  const hueZoneEditing =
    onSelectHueZone !== undefined &&
    onAddHueZone !== undefined &&
    onDeleteHueZone !== undefined &&
    onRenameHueZone !== undefined;

  const [activeTab, setActiveTab] = useState<DockTab>("objects");

  // Resolved once; the priority order and why it was swapped are on
  // `resolveInspectorTarget` itself.
  const inspectorTarget = resolveInspectorTarget(
    config,
    selectedId,
    activeHueZoneId,
  );

  const tabs: Array<{ id: DockTab; label: string; count?: number; visible: boolean }> = [
    { id: "objects", label: t("roomMap:objectPanel.objectsTab"), visible: true },
    {
      id: "hueZones",
      label: t("roomMap:objectPanel.hueZonesTab"),
      count: hueZones.length,
      visible: hueZoneEditing,
    },
  ];

  // `${kind}:${id}`, not just the kind — without the remount, the number field's
  // in-flight typed string leaks between two objects of the same kind. See
  // docs/architecture/room-map.md.
  const renderInspector = () => {
    switch (inspectorTarget.kind) {
      case "hueZone": {
        // v1.5 W4-F2: only Hue zones survive in `config.zones[]`. The
        // dispatcher feeds the canonical `HueZone` straight into
        // HueZoneInspector with no projection step.
        const zone = inspectorTarget.zone;
        return (
          <HueZoneInspector
            key={`hueZone:${zone.id}`}
            zone={zone}
            onUpdate={(patch) => onUpdateHueZone?.(zone.id, patch)}
            roomWidthM={config.dimensions.widthMeters}
            roomDepthM={config.dimensions.depthMeters}
          />
        );
      }
      case "tv":
        return (
          <TvAnchorInspector
            key="tv:singleton"
            tv={inspectorTarget.tv}
            onUpdate={(patch) => onUpdateTvAnchor?.(patch)}
            onToggleLock={() => onToggleLock("tv")}
          />
        );
      case "furniture": {
        const item = inspectorTarget.item;
        return (
          <FurnitureInspector
            key={`furniture:${item.id}`}
            item={item}
            onUpdate={(patch) => onUpdateFurniture?.(item.id, patch)}
            onToggleLock={() => onToggleLock(furnitureObjectId(item.id))}
            onRename={(label) => onRenameFurniture(item.id, label)}
          />
        );
      }
      case "usb": {
        const strip = inspectorTarget.strip;
        return (
          <UsbStripInspector
            key={`usb:${strip.stripId}`}
            strip={strip}
            connectionStatus={usbConnectionStatus}
            connectedPort={usbConnectedPort}
            onUpdate={(patch) => onUpdateUsbStrip?.(strip.stripId, patch)}
            onToggleLock={() => onToggleLock(usbStripObjectId(strip.stripId))}
            onManage={onUsbManage}
          />
        );
      }
      case "hueChannel": {
        const ch = inspectorTarget.channel;
        return (
          <HueChannelInspector
            key={`hueChannel:${ch.channelIndex}`}
            channel={ch}
            zoneName={inspectorTarget.zoneName}
            bridgeStatus={hueChannelStatus}
            onRename={(label) =>
              onRenameHueChannel?.(ch.channelIndex, label)
            }
            onToggleLock={() => onToggleLock(hueChannelObjectId(ch.channelIndex))}
          />
        );
      }
      case "image": {
        const layer = inspectorTarget.layer;
        return (
          <ImageLayerInspector
            key={`image:${layer.id}`}
            layer={layer}
            onUpdate={(patch) => onUpdateImageLayer?.(layer.id, patch)}
            onToggleLock={() => onToggleLock(imageLayerObjectId(layer.id))}
            onRename={(label) => onRenameImageLayer?.(layer.id, label)}
          />
        );
      }
      default:
        return (
          <p className="lm-room-dock-inspect-empty">{t("roomMap:inspector.empty")}</p>
        );
    }
  };

  return (
    <aside className="lm-room-dock" aria-label={t("roomMap:objectPanel.dockAriaLabel")}>
      <div className="lm-room-dock-tabs" role="tablist">
        {tabs
          .filter((tab) => tab.visible)
          .map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              className={`lm-room-dock-tab ${activeTab === tab.id ? "is-on" : ""}`}
              onClick={() => setActiveTab(tab.id)}
            >
              <span>{tab.label}</span>
              {tab.count !== undefined && tab.count > 0 && (
                <span className="lm-room-dock-tab-count">{tab.count}</span>
              )}
            </button>
          ))}
      </div>

      <div className="lm-room-dock-body">
        <div className="lm-room-dock-list" role="tabpanel">
          {activeTab === "objects" ? (
            <ObjectsTab
              config={config}
              hueZones={hueZones}
              selectedId={selectedId}
              activeHueZoneId={activeHueZoneId}
              onSelect={onSelect}
              onSelectHueZone={onSelectHueZone}
              onDelete={onDelete}
              onRenameFurniture={onRenameFurniture}
              onToggleLock={onToggleLock}
            />
          ) : activeTab === "hueZones" && hueZoneEditing ? (
            <HueZonesTab
              hueZones={hueZones}
              channels={config.hueChannels}
              activeHueZoneId={activeHueZoneId}
              onSelectHueZone={onSelectHueZone!}
              onAddHueZone={onAddHueZone!}
              onDeleteHueZone={onDeleteHueZone!}
              onRenameHueZone={onRenameHueZone!}
              addHueZoneDisabled={addHueZoneDisabled}
              addHueZoneDisabledTooltip={addHueZoneDisabledTooltip}
              onSelectChannel={(idx) => onSelect(hueChannelObjectId(idx))}
              hueBridgeConfigured={hueBridgeConfigured}
              hueAreaId={hueAreaId}
              onAssignChannelToZone={onAssignChannelToZone}
              onNavigateToDevices={onNavigateToDevices}
            />
          ) : null}
        </div>

        <div className="lm-room-dock-inspect" role="region" aria-label={t("roomMap:inspector.regionAriaLabel")}>
          {renderInspector()}
        </div>
      </div>
    </aside>
  );
}
