import { useState, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { isEditableTarget } from "@/shared/lib/editableTarget";
import { useRoomMapState } from "../state/useRoomMapState";
import { RoomMapCanvas } from "./RoomMapCanvas";
import { RoomMapToolbar } from "./RoomMapToolbar";
import { RoomMapSettingsPopover } from "./RoomMapSettingsPopover";
import { RoomMapEmptyHint } from "./RoomMapEmptyHint";
import { FurnitureObject } from "./objects/FurnitureObject";
import { TvAnchorObject } from "./objects/TvAnchorObject";
import { UsbStripObject } from "./objects/UsbStripObject";
import { HueChannelOverlay } from "./HueChannelOverlay";
import { RoomDockPanel } from "./RoomDockPanel";
import { deriveZones, type ZoneDeriveResult } from "../model/deriveZones";
import { setHueChannelWorldZ } from "../model/hueChannelPosition";
import {
  furnitureObjectId,
  hueChannelObjectId,
  imageLayerObjectId,
  parseObjectId,
  TV_ANCHOR_OBJECT_ID,
  usbStripObjectId,
} from "../model/objectId";
import { useSnapGuides } from "../state/useSnapGuides";
import { useRoomMapGridSettings } from "../state/useRoomMapGridSettings";
import { useRoomMapHueChannels } from "../state/useRoomMapHueChannels";
import { useRoomMapHueZones } from "../state/useRoomMapHueZones";
import { imageLayerGestureKey, useRoomMapImageLayers } from "../state/useRoomMapImageLayers";
import { scopeHueChannels } from "../model/hueChannelScope";
import { useRoomMapObjects } from "../state/useRoomMapObjects";
import { ROOM_MAP_PX_PER_METER, useRoomMapViewport } from "../state/useRoomMapViewport";
import { SnapGuideOverlay } from "./SnapGuideOverlay";
import { OriginMarker } from "./OriginMarker";
import { ContextMenu, type ContextMenuAction } from "./ContextMenu";
import { LeftToolbar } from "./LeftToolbar";
import { MouseCoordinateDisplay } from "./MouseCoordinateDisplay";
import { ZoomControl } from "./ZoomControl";
import { canDeleteObjectKind } from "../model/objectCapability";
import { PropertyBar } from "./PropertyBar";
import { RenameDialog } from "./RenameDialog";
import { TemplateSelector } from "./TemplateSelector";
import { ZoneDeriveOverlay } from "./ZoneDeriveOverlay";
import type {
  FurniturePlacement,
  HueChannelPlacement,
  HueZoneStatusCode,
  RoomDimensions,
  RoomMapConfig,
  TvAnchorPlacement,
  UsbStripPlacement,
} from "@/shared/contracts/roomMap";
import {
  replaceHueChannel,
  ROOM_MAP_BACKGROUND_ERROR,
  ROOM_MAP_BACKGROUND_MAX_MB,
} from "@/shared/contracts/roomMap";
import type { LedSegmentCounts } from "@/features/calibration/model/contracts";
import type React from "react";
import { useUsbConnectionStatus } from "@/features/device/useUsbConnectionStatus";
import type { HueRuntimeTarget } from "@/shared/contracts/hue";
import type { HueProbeVerdict } from "@/features/hue/state/useHueBridgeReachability";
import { roomAwareStatus } from "../model/roomAware";

interface RoomMapEditorProps {
  onZoneCountsConfirmed?: (counts: LedSegmentCounts) => void;
  /**
   * Invoked when the dock state strip's CTA prompts the
   * user to finish Hue onboarding (pair bridge or pick an entertainment
   * area). The Settings shell wires this to `setActiveSection(DEVICES)`
   * so the user is dropped into the right place to recover.
   */
  onNavigateToDevices?: () => void;
  /**
   * App-level Hue reachability snapshot, forwarded into
   * the dock so HueChannelInspector + Hue zone rows can mirror the
   * "Bridge offline" state alongside the existing USB connection chip
   * pattern. `undefined` keeps the dock in legacy "unknown" mode so
   * embeds that do not own a reachability source render no chip.
   */
  hueReachable?: boolean;
  /** Selected outputs; with a TV anchor, a Hue target turns the room-aware chip on. */
  outputTargets?: HueRuntimeTarget[];
  /** A bridge is paired. Without one the room-aware chip stays hidden. */
  hueConfigured?: boolean;
  /** Picks the paused room-aware chip's reason, as it does the Lights Hue row's. */
  hueProbeVerdict?: HueProbeVerdict | null;
}

const IS_MAC = navigator.platform.includes("Mac");

// Literal keys, not `\`…${code}\``, so the orphan ratchet can see each one.
const HUE_ZONE_REJECTION_KEYS = {
  HUE_ZONE_CREATED: "roomMap:hueZones.rejected.generic",
  HUE_ZONE_UPDATED: "roomMap:hueZones.rejected.generic",
  HUE_ZONE_DELETED: "roomMap:hueZones.rejected.generic",
  HUE_ZONE_NOT_FOUND: "roomMap:hueZones.rejected.notFound",
  HUE_ZONE_CHANNEL_OUT_OF_BOUNDS: "roomMap:hueZones.rejected.outOfBounds",
  HUE_ZONE_LIMIT_REACHED: "roomMap:hueZones.rejected.limitReached",
  HUE_ZONE_CHANNEL_NOT_IN_AREA: "roomMap:hueZones.rejected.notInArea",
  HUE_ZONE_OVERSIZED: "roomMap:hueZones.rejected.oversized",
} as const satisfies Record<HueZoneStatusCode, string>;

export function RoomMapEditor({
  onZoneCountsConfirmed,
  onNavigateToDevices,
  hueReachable,
  outputTargets = [],
  hueConfigured = false,
  hueProbeVerdict = null,
}: RoomMapEditorProps = {}) {
  const { t } = useTranslation();
  const {
    config,
    selectedId,
    activeHueZoneId,
    apply,
    adopt,
    replace,
    reset,
    undo,
    redo,
    select,
    selectHueZone,
    canUndo,
    canRedo,
    loading,
    error,
  } = useRoomMapState();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [derivePreview, setDerivePreview] = useState<ZoneDeriveResult | null>(null);
  const [renameTarget, setRenameTarget] = useState<{ id: string; currentLabel: string } | null>(null);
  const [objectPanelOpen, setObjectPanelOpen] = useState(true);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; targetId: string } | null>(null);

  const {
    showGrid,
    setShowGrid,
    gridStrokeWidth,
    setGridStrokeWidth,
    showHueZones,
    setShowHueZones,
  } = useRoomMapGridSettings();

  const {
    hueZones,
    activeHueZone,
    hueAreaId,
    hueBridgeConfigured,
    hueZoneRejection,
    dismissHueZoneRejection,
    handleAddHueZone,
    handleDeleteHueZone,
    handleRenameHueZone,
    handleAssignChannelToZone,
    handleHueZoneCenterChange,
    handleHueZoneUpdate,
  } = useRoomMapHueZones({
    config,
    apply,
    adopt,
    activeHueZoneId,
    selectHueZone,
    setObjectPanelOpen,
  });

  const { areaChannels, channelsStatus, isLoadingChannels, liveChannelIds, refreshChannels } =
    useRoomMapHueChannels({
    config,
    adopt,
    hueAreaId,
    hueBridgeConfigured,
    ready: !loading,
  });

  const { guides: snapGuides, onDragMove: snapDragMove, onDragEnd: snapDragEnd } = useSnapGuides(config);

  const {
    canvasContainerRef,
    setCanvasContainer,
    canvasSize,
    zoom,
    setZoom,
    panOffset,
    setPanOffset,
    spaceHeld,
    fitToView,
    handleArrowPan,
  } = useRoomMapViewport(config.dimensions);

  // Same `connectionEvents` bus the Lights and Devices flows use, so a pair or
  // disconnect anywhere in the app re-syncs the editor without a reload.
  const usb = useUsbConnectionStatus();

  const {
    handleAddTv,
    handleAddFurniture,
    handleAddUsb,
    deleteById,
    handleDelete,
    handleRotate,
    handleDuplicate,
    handleArrowNudge,
    handleUpdatePosition,
    handleUpdateSize,
    handleUpdateRotation,
    handleRenameFurniture,
  } = useRoomMapObjects({ config, hueAreaId, apply, selectedId, select });

  const {
    handleAddImage,
    imageError,
    imageErrorCode,
    handleUpdateImageOpacity,
    handleUpdateImageScale,
    handleUpdateImageAspectLock,
    handleResetImageScale,
    handleRenameImage,
  } = useRoomMapImageLayers({ config, apply, select });

  const { widthMeters, depthMeters } = config.dimensions;

  const usbConnectionStatus = usb.ready
    ? (usb.connectedPort ? "connected" : "disconnected")
    : "unknown";
  // `undefined` means no source of truth (a legacy embed passes nothing) and
  // must render no chip at all — it is not the same as `false`.
  const hueChannelStatus: "connected" | "disconnected" | "unknown" =
    hueReachable === undefined
      ? "unknown"
      : hueReachable
        ? "connected"
        : "disconnected";
  // There is no Rust `disconnect_serial_port` yet, so this deep-links to Devices.
  // Kept as a callback so a real disconnect can replace it without touching
  // consumers.
  const handleManageUsb = useCallback(() => {
    onNavigateToDevices?.();
  }, [onNavigateToDevices]);

  const pxPerMeter = ROOM_MAP_PX_PER_METER;
  const gridStepM = widthMeters < 4 ? 0.5 : 1.0;
  const gridStepPx = gridStepM * pxPerMeter;

  // The editor's object ids carry an index and no area, so it shows one area at
  // a time; placing several independently is P3 work and needs a wider id.
  const visibleHueChannels = useMemo(
    () => scopeHueChannels(config.hueChannels, hueAreaId),
    [config.hueChannels, hueAreaId],
  );
  // What the dock and the property bar read: the same one area the canvas
  // draws, or an object list and inspector keyed on `hue-<index>` would show,
  // and select, another area's same-numbered channel.
  const scopedConfig = useMemo<RoomMapConfig>(
    () =>
      visibleHueChannels === config.hueChannels
        ? config
        : { ...config, hueChannels: visibleHueChannels },
    [config, visibleHueChannels],
  );

  // Canvas objects are memoised, so every callback they receive has to be
  // stable: an inline closure would re-render all of them on a pan commit.
  const handleCanvasClick = useCallback(() => select(null), [select]);
  const handleUsbStripSelect = useCallback((id: string) => select(usbStripObjectId(id)), [select]);
  const handleUsbStripChange = useCallback(
    (updated: UsbStripPlacement, continuous?: boolean) => {
      apply(
        (cfg) => ({
          usbStrips: cfg.usbStrips.map((s) => (s.stripId === updated.stripId ? updated : s)),
        }),
        continuous ? { gesture: `usb:${updated.stripId}:ledCount` } : undefined,
      );
    },
    [apply],
  );
  const handleFurnitureSelect = useCallback((id: string) => select(furnitureObjectId(id)), [select]);
  const handleFurnitureChange = useCallback(
    (updated: FurniturePlacement) => {
      apply((cfg) => ({
        furniture: cfg.furniture.map((item) => (item.id === updated.id ? updated : item)),
      }));
    },
    [apply],
  );
  const handleTvSelect = useCallback(() => select(TV_ANCHOR_OBJECT_ID), [select]);
  const handleTvChange = useCallback(
    (updated: TvAnchorPlacement) => apply({ tvAnchor: updated }),
    [apply],
  );
  const handleHueChannelSelect = useCallback(
    (channelIndex: number) => select(hueChannelObjectId(channelIndex)),
    [select],
  );
  const handleHueChannelChange = useCallback(
    (updated: HueChannelPlacement) => {
      apply((cfg) => ({ hueChannels: replaceHueChannel(cfg.hueChannels, updated) }));
    },
    [apply],
  );
  const handleImageLayerSelect = useCallback((id: string) => select(imageLayerObjectId(id)), [select]);
  const handleImageLayerTransformChange = useCallback(
    (
      id: string,
      offsetX: number,
      offsetY: number,
      scale: number,
      scaleX?: number,
      scaleY?: number,
      continuous?: boolean,
    ) => {
      apply(
        (cfg) => ({
          imageLayers: cfg.imageLayers.map((l) =>
            l.id === id
              ? {
                  ...l,
                  offsetX,
                  offsetY,
                  scale,
                  ...(scaleX != null ? { scaleX } : {}),
                  ...(scaleY != null ? { scaleY } : {}),
                }
              : l,
          ),
        }),
        continuous ? { gesture: imageLayerGestureKey(id, "scale") } : undefined,
      );
    },
    [apply],
  );

  // Derived
  const hasTv = !!config.tvAnchor;
  const hasUsb = config.usbStrips.length > 0;
  const derivePreviewActive = derivePreview !== null;
  const isEmpty =
    !config.tvAnchor &&
    config.furniture.length === 0 &&
    config.usbStrips.length === 0 &&
    visibleHueChannels.length === 0;

  // Zone derivation handlers
  const handleDeriveZones = useCallback(() => {
    if (derivePreview) {
      // Toggle off if already active
      setDerivePreview(null);
      return;
    }
    const strip = config.usbStrips[0];
    const tv = config.tvAnchor;
    if (!strip || !tv) return;
    const result = deriveZones(strip, tv);
    if (result.counts.top + result.counts.right + result.counts.bottom + result.counts.left === 0) {
      return;
    }
    setDerivePreview(result);
  }, [config.usbStrips, config.tvAnchor, derivePreview]);

  const handleDeriveConfirm = useCallback(() => {
    if (!derivePreview) return;
    onZoneCountsConfirmed?.(derivePreview.counts);
    setDerivePreview(null);
  }, [derivePreview, onZoneCountsConfirmed]);

  const handleDeriveDiscard = useCallback(() => {
    setDerivePreview(null);
  }, []);

  const handleSelectObject = useCallback((id: string | null) => {
    select(id);
    if (id !== null) selectHueZone(null);
  }, [select, selectHueZone]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      // A field's keys are the field's: Backspace in the LED count deleted the
      // strip, and Cmd+Z replaced the field's own undo with the editor's.
      if (isEditableTarget(e.target)) return;
      // Undo: Cmd+Z (Mac) / Ctrl+Z (Win/Linux)
      if ((e.metaKey || e.ctrlKey) && e.key === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
        return;
      }
      // Redo: Cmd+Shift+Z (Mac) / Ctrl+Shift+Z (Win/Linux)
      if ((e.metaKey || e.ctrlKey) && e.key === "z" && e.shiftKey) {
        e.preventDefault();
        redo();
        return;
      }
      // Fit to view: Cmd+0 (Mac) / Ctrl+0 (Win/Linux)
      if ((e.metaKey || e.ctrlKey) && e.key === "0") {
        e.preventDefault();
        fitToView(16);
        return;
      }
      // Duplicate: Cmd+D (Mac) / Ctrl+D (Win/Linux)
      if ((e.metaKey || e.ctrlKey) && (e.key === "d" || e.key === "D")) {
        e.preventDefault();
        if (selectedId) handleDuplicate(selectedId);
        return;
      }
      if (e.key === "Escape") {
        select(null);
        setContextMenu(null);
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        handleDelete();
      } else if ((e.key === "r" || e.key === "R") && !e.metaKey && !e.ctrlKey) {
        handleRotate();
      } else if ((e.key === "f" || e.key === "F") && !e.metaKey && !e.ctrlKey) {
        setObjectPanelOpen((v) => !v);
      } else if (selectedId) {
        handleArrowNudge(e);
      } else {
        // Arrows were a dead key with nothing selected, which left keyboard-only
        // users no way to move the viewport at all.
        handleArrowPan(e);
      }
    },
    [handleDelete, handleRotate, handleArrowNudge, handleArrowPan, handleDuplicate, undo, redo, select, selectedId, fitToView],
  );

  const handleDimensionsChange = useCallback(
    (d: RoomDimensions) => {
      // Keep room center fixed on screen when resizing (pxPerMeter is constant)
      const oldCenterScreenX = panOffset.x + (widthMeters / 2) * pxPerMeter * zoom;
      const oldCenterScreenY = panOffset.y + (depthMeters / 2) * pxPerMeter * zoom;

      const newPanX = oldCenterScreenX - (d.widthMeters / 2) * pxPerMeter * zoom;
      const newPanY = oldCenterScreenY - (d.depthMeters / 2) * pxPerMeter * zoom;
      setPanOffset({ x: newPanX, y: newPanY });

      // Shift all objects so they keep their position relative to room center
      const dxM = (d.widthMeters - widthMeters) / 2;
      const dyM = (d.depthMeters - depthMeters) / 2;
      const dxPx = dxM * pxPerMeter;
      const dyPx = dyM * pxPerMeter;

      const patch: Partial<typeof config> = { dimensions: d };

      if (config.tvAnchor) {
        patch.tvAnchor = { ...config.tvAnchor, x: config.tvAnchor.x + dxM, y: config.tvAnchor.y + dyM };
      }
      if (config.furniture.length > 0) {
        patch.furniture = config.furniture.map((f) => ({ ...f, x: f.x + dxM, y: f.y + dyM }));
      }
      if (config.usbStrips.length > 0) {
        patch.usbStrips = config.usbStrips.map((s) => ({ ...s, startX: s.startX + dxM, startY: s.startY + dyM, endX: s.endX + dxM, endY: s.endY + dyM }));
      }
      // Hue channels and zones are not shifted: they live in the bridge's [-1, 1]
      // cube, which spans the room, so they already follow its new size.
      if (config.imageLayers.length > 0) {
        patch.imageLayers = config.imageLayers.map((l) => ({ ...l, offsetX: l.offsetX + dxPx, offsetY: l.offsetY + dyPx }));
      }

      apply(patch);
    },
    [apply, config, panOffset, widthMeters, depthMeters, zoom, setPanOffset],
  );

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      if (!selectedId) return;
      setContextMenu({ x: e.clientX, y: e.clientY, targetId: selectedId });
    },
    [selectedId],
  );

  const getContextMenuActions = useCallback((): ContextMenuAction[] => {
    if (!contextMenu) return [];
    const id = contextMenu.targetId;
    const actions: ContextMenuAction[] = [];

    const parsed = parseObjectId(id);
    const canDuplicate = parsed?.kind === "furniture" || parsed?.kind === "usb";
    if (canDuplicate) {
      actions.push({
        label: t("roomMap:contextMenu.duplicate"),
        shortcut: IS_MAC ? "\u2318D" : "Ctrl+D",
        onClick: () => handleDuplicate(id),
      });
    }

    if (parsed?.kind === "furniture") {
      const furnitureId = parsed.furnitureId;
      actions.push({
        label: t("roomMap:contextMenu.rename"),
        onClick: () => {
          const current = config.furniture.find((f) => f.id === furnitureId);
          setRenameTarget({ id: furnitureId, currentLabel: current?.label ?? "" });
        },
      });
      actions.push({
        label: t("roomMap:contextMenu.rotate"),
        shortcut: "R",
        onClick: () => {
          select(id);
          handleRotate();
        },
      });
    }

    if (parsed?.kind === "image") {
      const imageId = parsed.layerId;
      const current = config.imageLayers.find((l) => l.id === imageId);
      actions.push({
        label: t("roomMap:contextMenu.rename"),
        onClick: () => {
          setRenameTarget({ id: imageLayerObjectId(imageId), currentLabel: current?.label ?? "" });
        },
      });
    }

    if (canDeleteObjectKind(parsed?.kind)) {
      actions.push({
        label: t("roomMap:contextMenu.delete"),
        shortcut: IS_MAC ? "\u232B" : "Del",
        danger: true,
        onClick: () => deleteById(id),
      });
    }

    return actions;
  }, [contextMenu, t, handleDuplicate, handleRotate, deleteById, select, config.furniture, config.imageLayers]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <span className="text-sm text-[var(--lm-ink-faint)]">{t("roomMap:loading")}</span>
      </div>
    );
  }

  // Show template selector for empty maps with no edit history
  if (isEmpty && !canUndo) {
    return <TemplateSelector onSelect={replace} />;
  }

  return (
    <div
      className="lm-room-editor flex h-full flex-col"
      onKeyDown={handleKeyDown}
      onContextMenu={handleContextMenu}
      tabIndex={0}
    >
      <RoomMapToolbar
        hasTv={hasTv}
        hasUsb={hasUsb}
        roomAware={roomAwareStatus(config.tvAnchor, outputTargets, {
          configured: hueConfigured,
          reachable: hueReachable ?? false,
          verdict: hueProbeVerdict,
        })}
        derivePreviewActive={derivePreviewActive}
        zoneCount={config.zones.length}
        onDeriveZones={handleDeriveZones}
        onAddZone={handleAddHueZone}
        settingsOpen={settingsOpen}
        onToggleSettings={() => setSettingsOpen((v) => !v)}
        canUndo={canUndo}
        canRedo={canRedo}
        onUndo={undo}
        onRedo={redo}
      />
      <div className="flex flex-1 min-h-0">
        <div
          className="relative flex-1"
          ref={setCanvasContainer}
        >
          {/* Floating tool chips — top-left of canvas */}
          <LeftToolbar
            hasTv={hasTv}
            onAddTv={handleAddTv}
            onAddFurniture={handleAddFurniture}
            onAddUsb={handleAddUsb}
            onAddImage={() => void handleAddImage()}
          />

          {settingsOpen && (
            <RoomMapSettingsPopover
              open={settingsOpen}
              onClose={() => setSettingsOpen(false)}
              dimensions={config.dimensions}
              showGrid={showGrid}
              onDimensionsChange={handleDimensionsChange}
              gridStrokeWidth={gridStrokeWidth}
              showHueZones={showHueZones}
              onGridToggle={setShowGrid}
              onGridStrokeWidthChange={setGridStrokeWidth}
              onHueZonesToggle={setShowHueZones}
              onReset={reset}
            />
          )}
          <RoomMapCanvas
            config={config}
            pxPerMeter={pxPerMeter}
            canvasSize={canvasSize}
            showGrid={showGrid}
            gridStrokeWidth={gridStrokeWidth}
            selectedId={selectedId}
            onCanvasClick={handleCanvasClick}
            onImageLayerTransformChange={handleImageLayerTransformChange}
            onImageLayerSelect={handleImageLayerSelect}
            zoom={zoom}
            panOffset={panOffset}
            onZoomChange={setZoom}
            onPanChange={setPanOffset}
            panMode={spaceHeld}
          >
            {isEmpty && <RoomMapEmptyHint />}

            {/* Origin crosshair marker — always centered, extends to edges */}
            <OriginMarker
              widthM={widthMeters}
              depthM={depthMeters}
              pxPerMeter={pxPerMeter}
            />

            {/* USB strip SVG overlay + handles */}
            {config.usbStrips.map((strip) => {
              // Graded per strip against the live port, so a controller moved to
              // another port reads OFFLINE. Legacy strips with no `portName`
              // keep the old any-port-active heuristic.
              const stripStatus: "connected" | "disconnected" | "unknown" = strip.portName
                ? usb.ready
                  ? strip.portName === usb.connectedPort
                    ? "connected"
                    : "disconnected"
                  : "unknown"
                : usbConnectionStatus;
              return (
              <UsbStripObject
                key={strip.stripId}
                placement={strip}
                pxPerMeter={pxPerMeter}
                selected={selectedId === usbStripObjectId(strip.stripId)}
                zoom={zoom}
                panMode={spaceHeld}
                connectionStatus={stripStatus}
                onSelect={handleUsbStripSelect}
                onChange={handleUsbStripChange}
              />
              );
            })}

            {/* Furniture objects */}
            {config.furniture.map((f) => (
              <FurnitureObject
                key={f.id}
                placement={f}
                pxPerMeter={pxPerMeter}
                selected={selectedId === furnitureObjectId(f.id)}
                gridStepPx={gridStepPx}
                snapEnabled={showGrid}
                zoom={zoom}
                panMode={spaceHeld}
                onSelect={handleFurnitureSelect}
                onChange={handleFurnitureChange}
                onSnapDragMove={snapDragMove}
                onSnapDragEnd={snapDragEnd}
              />
            ))}

            {/* TV anchor */}
            {config.tvAnchor && (
              <TvAnchorObject
                placement={config.tvAnchor}
                pxPerMeter={pxPerMeter}
                selected={selectedId === TV_ANCHOR_OBJECT_ID}
                gridStepPx={gridStepPx}
                snapEnabled={showGrid}
                zoom={zoom}
                panMode={spaceHeld}
                onSelect={handleTvSelect}
                onChange={handleTvChange}
                onSnapDragMove={snapDragMove}
                onSnapDragEnd={snapDragEnd}
              />
            )}

            {/* Hue channel dots + zone bounds — bug #53: bounds box must
                render even when no channels exist yet so the user can
                author a zone before the area is paired. Also
                mount whenever the user has at least one Hue zone AND
                the visibility toggle is on, so passive zones paint
                without needing an active selection. */}
            {(
              visibleHueChannels.length > 0
              || activeHueZone !== null
              || (showHueZones && hueZones.length > 0)
            ) && (
              <HueChannelOverlay
                channels={visibleHueChannels}
                liveChannelIds={liveChannelIds}
                pxPerMeter={pxPerMeter}
                roomWidthM={widthMeters}
                roomDepthM={depthMeters}
                zoom={zoom}
                selectedId={selectedId}
                onSelect={handleHueChannelSelect}
                onChange={handleHueChannelChange}
                panMode={spaceHeld}
                activeHueZone={activeHueZone}
                onHueZoneCenterChange={handleHueZoneCenterChange}
                allHueZones={hueZones}
                hidePassiveZoneBounds={!showHueZones}
              />
            )}

            {/* Zone derive preview overlay */}
            {derivePreview && config.tvAnchor && (
              <ZoneDeriveOverlay
                result={derivePreview}
                tv={config.tvAnchor}
                pxPerMeter={pxPerMeter}
                onConfirm={handleDeriveConfirm}
                onDiscard={handleDeriveDiscard}
              />
            )}

            {/* Snap alignment guides */}
            <SnapGuideOverlay
              guides={snapGuides}
              pxPerMeter={pxPerMeter}
              canvasWidth={canvasSize.w}
              canvasHeight={canvasSize.h}
            />

          </RoomMapCanvas>

          <ZoomControl
            zoom={zoom}
            canvasSize={canvasSize}
            panOffset={panOffset}
            onZoomChange={setZoom}
            onPanChange={setPanOffset}
            onFitToView={() => fitToView(16)}
            isMac={IS_MAC}
          />

          {/* Mouse coordinate display — fixed to bottom-right of canvas container */}
          <MouseCoordinateDisplay
            canvasContainerRef={canvasContainerRef}
            panOffset={panOffset}
            pxPerMeter={pxPerMeter}
            zoom={zoom}
            widthMeters={widthMeters}
            depthMeters={depthMeters}
          />
        </div>

        {/* Right dock — consolidated tabbed Objects / Zones / Hue Zones / Properties */}
        {objectPanelOpen && (
          <RoomDockPanel
            config={scopedConfig}
            selectedId={selectedId}
            onSelect={handleSelectObject}
            onDelete={deleteById}
            onRenameFurniture={handleRenameFurniture}
            onToggleLock={(id) => {
              const parsed = parseObjectId(id);
              if (parsed?.kind === "tv" && config.tvAnchor) {
                apply({ tvAnchor: { ...config.tvAnchor, locked: !config.tvAnchor.locked } });
              } else if (parsed?.kind === "furniture") {
                apply({ furniture: config.furniture.map((f) => (f.id === parsed.furnitureId ? { ...f, locked: !f.locked } : f)) });
              } else if (parsed?.kind === "usb") {
                apply({ usbStrips: config.usbStrips.map((s) => (s.stripId === parsed.stripId ? { ...s, locked: !s.locked } : s)) });
              } else if (parsed?.kind === "hue") {
                const target = visibleHueChannels.find((ch: HueChannelPlacement) => ch.channelIndex === parsed.channelIndex);
                if (target) {
                  apply({
                    hueChannels: replaceHueChannel(config.hueChannels, { ...target, locked: !target.locked }),
                  });
                }
              } else if (parsed?.kind === "image") {
                apply({ imageLayers: config.imageLayers.map((l) => (l.id === parsed.layerId ? { ...l, locked: !l.locked } : l)) });
              }
            }}
            hueZones={hueZones}
            activeHueZoneId={activeHueZoneId}
            onSelectHueZone={selectHueZone}
            onAddHueZone={handleAddHueZone}
            onDeleteHueZone={handleDeleteHueZone}
            onRenameHueZone={handleRenameHueZone}
            onUpdateHueZone={handleHueZoneUpdate}
            addHueZoneDisabled={!hueAreaId}
            addHueZoneDisabledTooltip={t("roomMap:hueZones.addDisabledTooltip")}
            hueBridgeConfigured={hueBridgeConfigured}
            onRefreshChannels={refreshChannels}
            isRefreshingChannels={isLoadingChannels}
            channelsStatus={channelsStatus}
            hueChannels={visibleHueChannels}
            areaChannels={areaChannels}
            liveChannelIds={liveChannelIds}
            hueAreaId={hueAreaId}
            onAssignChannelToZone={handleAssignChannelToZone}
            onNavigateToDevices={onNavigateToDevices}
            // Type-aware inspector patch hooks
            onUpdateTvAnchor={(patch) => {
              if (!config.tvAnchor) return;
              apply({ tvAnchor: { ...config.tvAnchor, ...patch } });
            }}
            onUpdateFurniture={(id, patch) => {
              apply({
                furniture: config.furniture.map((f) =>
                  f.id === id ? { ...f, ...patch } : f,
                ),
              });
            }}
            onUpdateUsbStrip={(stripId, patch) => {
              apply({
                usbStrips: config.usbStrips.map((s) =>
                  s.stripId === stripId ? { ...s, ...patch } : s,
                ),
              });
            }}
            onUpdateImageLayer={(id, patch) => {
              // The opacity slider lands here per input event.
              apply(
                {
                  imageLayers: config.imageLayers.map((l) =>
                    l.id === id ? { ...l, ...patch } : l,
                  ),
                },
                { gesture: imageLayerGestureKey(id, Object.keys(patch).sort().join(",")) },
              );
            }}
            onHueChannelHeightChange={(channelIndex, worldZ) => {
              const target = visibleHueChannels.find((ch: HueChannelPlacement) => ch.channelIndex === channelIndex);
              if (!target) return;
              // A slider, like the opacity one.
              apply(
                {
                  hueChannels: replaceHueChannel(
                    config.hueChannels,
                    setHueChannelWorldZ(target, config.zones, worldZ),
                  ),
                },
                { gesture: `hue-height:${channelIndex}` },
              );
            }}
            onRenameHueChannel={(channelIndex, label) => {
              const target = visibleHueChannels.find((ch: HueChannelPlacement) => ch.channelIndex === channelIndex);
              if (!target) return;
              apply({
                hueChannels: replaceHueChannel(config.hueChannels, { ...target, label }),
              });
            }}
            onRenameImageLayer={handleRenameImage}
            // USB connection status feed for inspectors
            usbConnectedPort={usb.connectedPort}
            usbConnectionStatus={usbConnectionStatus}
            onUsbManage={handleManageUsb}
            // Hue reachability mirror (parallel to the
            // USB connection status above). Drives the channel inspector
            // chip and Hue zone row dim-state.
            hueChannelStatus={hueChannelStatus}
          />
        )}
      </div>

      {/* Property bar */}
      <PropertyBar
        config={scopedConfig}
        selectedId={selectedId}
        onUpdatePosition={handleUpdatePosition}
        onUpdateSize={handleUpdateSize}
        onUpdateRotation={handleUpdateRotation}
        onUpdateImageOpacity={handleUpdateImageOpacity}
        onUpdateImageScale={handleUpdateImageScale}
        onUpdateImageAspectLock={handleUpdateImageAspectLock}
        onResetImageScale={handleResetImageScale}
      />

      {/* Context menu */}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          actions={getContextMenuActions()}
          onClose={() => setContextMenu(null)}
        />
      )}

      {/* Rename dialog */}
      {renameTarget && (
        <RenameDialog
          currentLabel={renameTarget.currentLabel}
          promptText={t("roomMap:contextMenu.renamePrompt")}
          onConfirm={(newName) => {
            // Image rows carry a prefixed object id here; furniture rows carry a bare id.
            const parsed = parseObjectId(renameTarget.id);
            if (parsed?.kind === "image") {
              handleRenameImage(parsed.layerId, newName);
            } else {
              handleRenameFurniture(renameTarget.id, newName);
            }
            setRenameTarget(null);
          }}
          onCancel={() => setRenameTarget(null)}
        />
      )}

      {error && (
        <div className="px-3 py-1.5 text-[11px] text-[color:var(--lm-red)]">
          {t("roomMap:persistError")}
        </div>
      )}

      {imageError && (
        <div role="alert" className="px-3 py-1.5 text-[11px] text-[color:var(--lm-red)]">
          {imageErrorCode === ROOM_MAP_BACKGROUND_ERROR.TOO_LARGE
            ? t("roomMap:imageTooLarge", { maxMb: ROOM_MAP_BACKGROUND_MAX_MB })
            : t("roomMap:imageImportError")}
        </div>
      )}

      {hueZoneRejection && (
        <div role="alert" className="flex items-center gap-2 px-3 py-1.5 text-[11px] text-[color:var(--lm-red)]">
          <span>{t(HUE_ZONE_REJECTION_KEYS[hueZoneRejection])}</span>
          <button
            type="button"
            onClick={dismissHueZoneRejection}
            aria-label={t("roomMap:hueZones.rejected.dismiss")}
            className="min-h-[32px] px-2 underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color:var(--lm-amber)]"
          >
            {t("roomMap:hueZones.rejected.dismiss")}
          </button>
        </div>
      )}
    </div>
  );
}
