import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import { useTranslation } from "react-i18next";

import type { FurnitureModel } from "@/features/room-view/model/furnitureModel";
import { ROOM_VIEW_3D_AVAILABLE } from "@/features/room-view/ui/RoomView3DHost";
import type {
  FurniturePlacement,
  HueChannelPlacement,
  HueZoneStatusCode,
  RoomDimensions,
  TvAnchorPlacement,
  UsbStripPlacement,
} from "@/shared/contracts/roomMap";
import { replaceHueChannel, ROOM_MAP_BACKGROUND_ERROR, ROOM_MAP_BACKGROUND_MAX_MB } from "@/shared/contracts/roomMap";
import { isEditableTarget } from "@/shared/lib/editableTarget";
import { Callout } from "@/shared/ui/Callout/Callout";

import { deriveHueAreaState } from "../model/hueAreaState";
import { setHueChannelWorldZ } from "../model/hueChannelPosition";
import {
  furnitureObjectId,
  hueChannelObjectId,
  imageLayerObjectId,
  parseObjectId,
  TV_ANCHOR_OBJECT_ID,
  usbStripObjectId,
} from "../model/objectId";
import type { RoomAwareStatus } from "../model/roomAware";
import { roomObjectAdapter } from "../model/roomObjectKinds";
import { useFurnitureModels } from "../state/useFurnitureModels";
import type { RoomMapDocument } from "../state/useRoomMapDocument";
import { useRoomMapGridSettings } from "../state/useRoomMapGridSettings";
import { useUsbStripStatus } from "../state/useUsbStripStatus";
import { useRoomMapHueZones } from "../state/useRoomMapHueZones";
import { imageLayerGestureKey, useRoomMapImageLayers } from "../state/useRoomMapImageLayers";
import { useRoomMapObjects } from "../state/useRoomMapObjects";
import { ROOM_MAP_PX_PER_METER, ROOM_MAP_VIEWPORT_ATTR, useRoomMapViewport } from "../state/useRoomMapViewport";
import { useSnapGuides } from "../state/useSnapGuides";
import { ContextMenu, type ContextMenuAction } from "./ContextMenu";
import { CornerControls } from "./CornerControls";
import { ROOM_MAP_FIT_INSETS } from "./dock/dockGeometry";
import type { InspectorActions } from "./dock/DockInspector";
import { RoomDock } from "./dock/RoomDock";
import { HueChannelOverlay } from "./HueChannelOverlay";
import { FurnitureObject } from "./objects/FurnitureObject";
import { TvAnchorObject } from "./objects/TvAnchorObject";
import { UsbStripObject } from "./objects/UsbStripObject";
import { OriginMarker } from "./OriginMarker";
import { RoomMapCanvas } from "./RoomMapCanvas";
import styles from "./RoomMapEditor.module.css";
import { SnapGuideOverlay } from "./SnapGuideOverlay";

export interface RoomMapEditorProps {
  /** The map, its history and its Hue area, owned by the surface so they outlive this face. */
  doc: RoomMapDocument;
  /** Opens Devices, where a bridge is paired, an area picked and a strip managed. */
  onNavigateToDevices?: () => void;
  /** App-level Hue reachability; `undefined` (an embed with no source of truth) shows no state. */
  hueReachable?: boolean;
  /** The room-aware chip's state; `null` hides it. */
  roomAware?: RoomAwareStatus | null;
  /** Take the keys on mount: the face opened from a control the switch just took away. */
  focusOnMount?: boolean;
}

const IS_MAC = navigator.platform.includes("Mac");
const BOX_MODEL: FurnitureModel = { kind: "box" };

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

function isCanvasKey(e: React.KeyboardEvent<HTMLElement>): boolean {
  if (e.target === e.currentTarget) return true;
  return e.target instanceof Element && e.target.closest(`[${ROOM_MAP_VIEWPORT_ATTR}]`) !== null;
}

export function RoomMapEditor({ doc, onNavigateToDevices, hueReachable, roomAware = null, focusOnMount = false }: RoomMapEditorProps) {
  const { t } = useTranslation();
  const {
    config,
    selectedId,
    activeHueZoneId,
    apply,
    adopt,
    reset,
    undo,
    redo,
    select,
    selectHueZone,
    clearSelection,
    canUndo,
    canRedo,
    error,
    hueAreaId,
    hueBridgeConfigured,
    visibleHueChannels,
    scopedConfig,
  } = doc;
  const { areaChannels, channelsStatus, isLoadingChannels, liveChannelIds, refreshChannels } = doc.hue;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; targetId: string } | null>(null);

  const { showGrid, setShowGrid, gridStrokeWidth, setGridStrokeWidth, showHueZones, setShowHueZones } = useRoomMapGridSettings();

  const {
    hueZones,
    activeHueZone,
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
    hueAreaId,
  });
  // The zones a light of the shown area can join: another area's zone holds another area's lights.
  const areaZones = useMemo(
    () => (hueAreaId ? hueZones.filter((zone) => zone.entertainmentAreaId === hueAreaId) : hueZones),
    [hueZones, hueAreaId],
  );

  const { guides: snapGuides, onDragMove: snapDragMove, onDragEnd: snapDragEnd } = useSnapGuides(config);
  const furnitureModels = useFurnitureModels(config);

  const { setCanvasContainer, canvasSize, zoom, setZoom, panOffset, setPanOffset, spaceHeld, fitToView, handleArrowPan } =
    useRoomMapViewport(config.dimensions, ROOM_MAP_FIT_INSETS);

  const { stripStatus, hueBridgeStatus } = useUsbStripStatus(hueReachable);

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
    handleRename,
  } = useRoomMapObjects({ config, hueAreaId, apply, selectedId, select });

  const { handleAddImage, imageError, imageErrorCode } = useRoomMapImageLayers({ apply, select });

  const { widthMeters, depthMeters } = config.dimensions;

  const pxPerMeter = ROOM_MAP_PX_PER_METER;
  const gridStepM = widthMeters < 4 ? 0.5 : 1.0;
  const gridStepPx = gridStepM * pxPerMeter;

  const focusEditor = useCallback(() => rootRef.current?.focus({ preventScroll: true }), []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: on mount only
  useEffect(() => {
    if (focusOnMount) focusEditor();
  }, []);
  // A pick from the list leaves the zone: a zone kept active dims every light outside it.
  const selectFromList = useCallback(
    (id: string) => {
      select(id);
      selectHueZone(null);
    },
    [select, selectHueZone],
  );
  // One step back: an object to the zone it was picked over, a zone to the palette.
  const popSelection = useCallback(() => {
    if (selectedId !== null) select(null);
    else if (activeHueZoneId !== null) selectHueZone(null);
  }, [selectedId, activeHueZoneId, select, selectHueZone]);

  // Canvas objects are memoised, so every callback they receive has to be
  // stable: an inline closure would re-render all of them on a pan commit.
  // Empty ground lets go of both: `select(null)` alone left a zone selected under the palette.
  const handleCanvasClick = clearSelection;
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
  const handleTvChange = useCallback((updated: TvAnchorPlacement) => apply({ tvAnchor: updated }), [apply]);
  const handleHueChannelSelect = useCallback((channelIndex: number) => select(hueChannelObjectId(channelIndex)), [select]);
  const handleHueChannelChange = useCallback(
    (updated: HueChannelPlacement) => {
      apply((cfg) => ({ hueChannels: replaceHueChannel(cfg.hueChannels, updated) }));
    },
    [apply],
  );
  const handleImageLayerSelect = useCallback((id: string) => select(imageLayerObjectId(id)), [select]);
  const handleImageLayerTransformChange = useCallback(
    (id: string, offsetX: number, offsetY: number, scale: number, scaleX?: number, scaleY?: number, continuous?: boolean) => {
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
      // Bare keys are the canvas's. On a dock tile, a segmented control or a menu
      // item an arrow moved the selection along with the control, and Delete
      // removed the selected object.
      if (!isCanvasKey(e)) return;
      if (e.key === "Escape") {
        popSelection();
        setContextMenu(null);
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        handleDelete();
      } else if ((e.key === "r" || e.key === "R") && !e.metaKey && !e.ctrlKey) {
        handleRotate();
      } else if (selectedId) {
        handleArrowNudge(e);
      } else {
        // Arrows were a dead key with nothing selected, which left keyboard-only
        // users no way to move the viewport at all.
        handleArrowPan(e);
      }
    },
    [handleDelete, handleRotate, handleArrowNudge, handleArrowPan, handleDuplicate, undo, redo, popSelection, selectedId, fitToView],
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
      // A right-click in a popover reaches here through the React tree from its portal; only the
      // plan has a menu.
      if (!(e.target instanceof Element) || e.target.closest(`[${ROOM_MAP_VIEWPORT_ATTR}]`) === null) return;
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
    const adapter = parsed ? roomObjectAdapter(parsed) : null;
    if (adapter?.duplicate) {
      actions.push({
        label: t("roomMap:contextMenu.duplicate"),
        shortcut: IS_MAC ? "⌘D" : "Ctrl+D",
        onClick: () => handleDuplicate(id),
      });
    }

    if (adapter?.rotateBy) {
      actions.push({
        label: t("roomMap:contextMenu.rotate"),
        shortcut: "R",
        onClick: () => {
          select(id);
          handleRotate();
        },
      });
    }

    if (adapter?.remove) {
      actions.push({
        label: t("roomMap:contextMenu.delete"),
        shortcut: IS_MAC ? "⌫" : t("roomMap:shortcuts.keys.del"),
        danger: true,
        onClick: () => deleteById(id),
      });
    }

    return actions;
  }, [contextMenu, t, handleDuplicate, handleRotate, deleteById, select]);

  // Inline closures on purpose: the dock is not memoised, and every one of these reads the
  // config as it is now.
  const inspectorActions: InspectorActions = {
    // A chip or swatch group selects on every arrow key; the gesture keeps a run of them one
    // undo step and one save, as the zone inspector's fields do.
    onUpdateTvAnchor: (patch) => {
      if (!config.tvAnchor) return;
      apply({ tvAnchor: { ...config.tvAnchor, ...patch } }, { gesture: `tv:${Object.keys(patch).sort().join(",")}` });
    },
    onUpdateFurniture: (id, patch) => {
      apply(
        { furniture: config.furniture.map((f) => (f.id === id ? { ...f, ...patch } : f)) },
        { gesture: `furniture:${id}:${Object.keys(patch).sort().join(",")}` },
      );
    },
    onUpdateUsbStrip: (stripId, patch) => {
      apply({ usbStrips: config.usbStrips.map((s) => (s.stripId === stripId ? { ...s, ...patch } : s)) });
    },
    onUpdateImageLayer: (id, patch) => {
      // The opacity slider lands here per input event.
      apply(
        { imageLayers: config.imageLayers.map((l) => (l.id === id ? { ...l, ...patch } : l)) },
        { gesture: imageLayerGestureKey(id, Object.keys(patch).sort().join(",")) },
      );
    },
    // A held arrow in X or Y steps many times; the gesture keeps it one undo step and one save.
    onMoveObject: (id, x, y) => handleUpdatePosition(id, x, y, { gesture: `move:${id}` }),
    onHueChannelHeightChange: (channelIndex, worldZ) => {
      const target = visibleHueChannels.find((ch) => ch.channelIndex === channelIndex);
      if (!target) return;
      // A slider, like the opacity one.
      apply(
        { hueChannels: replaceHueChannel(config.hueChannels, setHueChannelWorldZ(target, config.zones, worldZ)) },
        { gesture: `hue-height:${channelIndex}` },
      );
    },
    onRename: handleRename,
    onToggleLock: (id) => {
      const ref = parseObjectId(id);
      const patch = ref ? roomObjectAdapter(ref).toggleLock(config, ref, visibleHueChannels) : null;
      if (patch) apply(patch);
    },
    onDuplicate: handleDuplicate,
    onDelete: deleteById,
    onUpdateHueZone: handleHueZoneUpdate,
    onRenameHueZone: handleRenameHueZone,
    onDeleteHueZone: handleDeleteHueZone,
    onAssignChannelToZone: handleAssignChannelToZone,
    // Deep-links to Devices: no window may call `disconnect_serial_port` until the Devices page
    // carries a strip's Disconnect.
    onManageUsb: onNavigateToDevices,
  };

  const hasTv = !!config.tvAnchor;
  const hasHue = hueBridgeConfigured || hueAreaId !== null || visibleHueChannels.length > 0 || hueZones.length > 0;
  const freeHeight = Math.max(0, canvasSize.h - ROOM_MAP_FIT_INSETS.top - ROOM_MAP_FIT_INSETS.bottom);

  return (
    <div ref={rootRef} className="lm-room-editor relative h-full" onKeyDown={handleKeyDown} onContextMenu={handleContextMenu} tabIndex={0}>
      <div className={styles.stage} ref={setCanvasContainer} data-testid="room-map-stage">
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
          {/* Origin crosshair marker — always centered, extends to edges */}
          <OriginMarker widthM={widthMeters} depthM={depthMeters} pxPerMeter={pxPerMeter} />

          {config.usbStrips.map((strip) => (
            <UsbStripObject
              key={strip.stripId}
              placement={strip}
              pxPerMeter={pxPerMeter}
              selected={selectedId === usbStripObjectId(strip.stripId)}
              zoom={zoom}
              panMode={spaceHeld}
              connectionStatus={stripStatus(strip).status}
              onSelect={handleUsbStripSelect}
              onChange={handleUsbStripChange}
            />
          ))}

          {config.furniture.map((f) => (
            <FurnitureObject
              key={f.id}
              placement={f}
              model={furnitureModels.get(f.id) ?? BOX_MODEL}
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
          {(visibleHueChannels.length > 0 || activeHueZone !== null || (showHueZones && hueZones.length > 0)) && (
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

          <SnapGuideOverlay guides={snapGuides} pxPerMeter={pxPerMeter} canvasWidth={canvasSize.w} canvasHeight={canvasSize.h} />
        </RoomMapCanvas>

        <CornerControls
          roomAware={roomAware}
          edit={{
            canUndo,
            canRedo,
            onUndo: undo,
            onRedo: redo,
            zoom,
            canvasSize,
            panOffset,
            anchor: { x: canvasSize.w / 2, y: ROOM_MAP_FIT_INSETS.top + freeHeight / 2 },
            onZoomChange: setZoom,
            onPanChange: setPanOffset,
            onFitToView: () => fitToView(16),
          }}
        />

        {(error || imageError || hueZoneRejection) && (
          <div className={styles.alerts}>
            {error && <Callout tone="error">{t("roomMap:persistError")}</Callout>}
            {imageError && (
              <Callout tone="error">
                {imageErrorCode === ROOM_MAP_BACKGROUND_ERROR.TOO_LARGE
                  ? t("roomMap:imageTooLarge", { maxMb: ROOM_MAP_BACKGROUND_MAX_MB })
                  : t("roomMap:imageImportError")}
              </Callout>
            )}
            {hueZoneRejection && (
              <Callout tone="error" action={{ label: t("roomMap:hueZones.rejected.dismiss"), onClick: dismissHueZoneRejection }}>
                {t(HUE_ZONE_REJECTION_KEYS[hueZoneRejection])}
              </Callout>
            )}
          </div>
        )}

        <RoomDock
          config={scopedConfig}
          zones={areaZones}
          selectedId={selectedId}
          activeHueZoneId={activeHueZoneId}
          channels={visibleHueChannels}
          areaChannels={areaChannels}
          liveChannelIds={liveChannelIds}
          stripStatus={stripStatus}
          hueBridgeStatus={hueBridgeStatus}
          modelChoices={ROOM_VIEW_3D_AVAILABLE}
          actions={inspectorActions}
          add={{
            hasTv,
            onAddFurniture: handleAddFurniture,
            onAddTv: handleAddTv,
            onSelectTv: handleTvSelect,
            onAddStrip: handleAddUsb,
            onAddImage: () => void handleAddImage(),
            onAddZone: handleAddHueZone,
          }}
          hue={
            hasHue
              ? {
                  state: deriveHueAreaState(hueBridgeConfigured, hueAreaId),
                  zoneCount: areaZones.length,
                  channelsStatus,
                  refreshing: isLoadingChannels,
                  onRefresh: refreshChannels,
                  onNavigateToDevices,
                }
              : null
          }
          room={{
            dimensions: config.dimensions,
            onDimensionsChange: handleDimensionsChange,
            showGrid,
            onShowGridChange: setShowGrid,
            gridStrokeWidth,
            onGridStrokeWidthChange: setGridStrokeWidth,
            showHueZones,
            onShowHueZonesChange: setShowHueZones,
          }}
          onReset={reset}
          onSelect={selectFromList}
          onSelectZone={selectHueZone}
          onPopSelection={popSelection}
          onFocusEditor={focusEditor}
        />
      </div>

      {contextMenu && (
        <ContextMenu x={contextMenu.x} y={contextMenu.y} actions={getContextMenuActions()} onClose={() => setContextMenu(null)} />
      )}
    </div>
  );
}
