import { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useRoomMapPersist } from "../state/useRoomMapPersist";
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
import { useRoomMapHueZones } from "../state/useRoomMapHueZones";
import { useRoomMapImageLayers } from "../state/useRoomMapImageLayers";
import { useRoomMapObjects } from "../state/useRoomMapObjects";
import { ROOM_MAP_PX_PER_METER, useRoomMapViewport } from "../state/useRoomMapViewport";
import { SnapGuideOverlay } from "./SnapGuideOverlay";
import { OriginMarker } from "./OriginMarker";
import { ContextMenu, type ContextMenuAction } from "./ContextMenu";
import { LeftToolbar } from "./LeftToolbar";
import { MouseCoordinateDisplay } from "./MouseCoordinateDisplay";
import { PropertyBar } from "./PropertyBar";
import { RenameDialog } from "./RenameDialog";
import { TemplateSelector } from "./TemplateSelector";
import { ZoneDeriveOverlay } from "./ZoneDeriveOverlay";
import type { RoomDimensions } from "@/shared/contracts/roomMap";
import type { LedSegmentCounts } from "@/features/calibration/model/contracts";
import React from "react";
import { useUsbConnectionStatus } from "@/features/device/useUsbConnectionStatus";

interface RoomMapEditorProps {
  onZoneCountsConfirmed?: (counts: LedSegmentCounts) => void;
  /**
   * Wave 4-B (B1) — invoked when the dock state strip's CTA prompts the
   * user to finish Hue onboarding (pair bridge or pick an entertainment
   * area). The Settings shell wires this to `setActiveSection(DEVICES)`
   * so the user is dropped into the right place to recover.
   */
  onNavigateToDevices?: () => void;
  /**
   * Wave 4-G #4 — App-level Hue reachability snapshot, forwarded into
   * the dock so HueChannelInspector + Hue zone rows can mirror the
   * "Bridge offline" state alongside the existing USB connection chip
   * pattern. `undefined` keeps the dock in legacy "unknown" mode so
   * embeds that do not own a reachability source render no chip.
   */
  hueReachable?: boolean;
}

export function RoomMapEditor({ onZoneCountsConfirmed, onNavigateToDevices, hueReachable }: RoomMapEditorProps = {}) {
  const { t } = useTranslation();
  const { config, updateConfig, replaceConfig, resetConfig, undo, redo, canUndo, canRedo, loading, error } = useRoomMapPersist();
  const [selectedId, setSelectedId] = useState<string | null>(null);
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
    activeHueZoneId,
    activeHueZone,
    hueAreaId,
    hueBridgeConfigured,
    handleAddHueZone,
    handleDeleteHueZone,
    handleRenameHueZone,
    handleSelectHueZone,
    handleAssignChannelToZone,
    handleHueZoneCenterChange,
    handleHueZoneUpdate,
  } = useRoomMapHueZones({ config, updateConfig, setSelectedId, setObjectPanelOpen });

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
  } = useRoomMapViewport(config.dimensions);

  // Same `connectionEvents` bus the Lights and Devices flows use, so a pair or
  // disconnect anywhere in the app re-syncs the editor without a reload.
  const usb = useUsbConnectionStatus();

  const {
    handleAddTv,
    handleAddFurniture,
    handleAddUsb,
    handleAddHue,
    deleteById,
    handleDelete,
    handleRotate,
    handleDuplicate,
    handleArrowNudge,
    handleUpdatePosition,
    handleUpdateSize,
    handleUpdateRotation,
    handleRenameFurniture,
  } = useRoomMapObjects({ config, updateConfig, selectedId, setSelectedId });

  const {
    handleAddImage,
    handleUpdateImageOpacity,
    handleUpdateImageScale,
    handleUpdateImageAspectLock,
    handleResetImageScale,
    handleRenameImage,
  } = useRoomMapImageLayers({ config, updateConfig, setSelectedId });

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

  // Derived
  const hasTv = !!config.tvAnchor;
  const hasUsb = config.usbStrips.length > 0;
  const derivePreviewActive = derivePreview !== null;
  const isEmpty =
    !config.tvAnchor &&
    config.furniture.length === 0 &&
    config.usbStrips.length === 0 &&
    config.hueChannels.length === 0;

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
    setSelectedId(id);
    if (id !== null) handleSelectHueZone(null);
  }, [handleSelectHueZone]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      // Undo: Cmd+Z (Mac) / Ctrl+Z (Win/Linux)
      if ((e.metaKey || e.ctrlKey) && e.key === "z" && !e.shiftKey) {
        e.preventDefault();
        void undo();
        return;
      }
      // Redo: Cmd+Shift+Z (Mac) / Ctrl+Shift+Z (Win/Linux)
      if ((e.metaKey || e.ctrlKey) && e.key === "z" && e.shiftKey) {
        e.preventDefault();
        void redo();
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
        setSelectedId(null);
        setContextMenu(null);
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        handleDelete();
      } else if ((e.key === "r" || e.key === "R") && !e.metaKey && !e.ctrlKey) {
        handleRotate();
      } else if ((e.key === "f" || e.key === "F") && !e.metaKey && !e.ctrlKey) {
        setObjectPanelOpen((v) => !v);
      } else {
        handleArrowNudge(e);
      }
    },
    [handleDelete, handleRotate, handleArrowNudge, handleDuplicate, undo, redo, selectedId, fitToView],
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
      if (config.hueChannels.length > 0) {
        patch.hueChannels = config.hueChannels.map((ch) => ({ ...ch, x: ch.x + dxM, y: ch.y + dyM }));
      }
      if (config.imageLayers.length > 0) {
        patch.imageLayers = config.imageLayers.map((l) => ({ ...l, offsetX: l.offsetX + dxPx, offsetY: l.offsetY + dyPx }));
      }

      void updateConfig(patch);
    },
    [updateConfig, config, panOffset, widthMeters, depthMeters, zoom, pxPerMeter, setPanOffset],
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
    const isMac = navigator.platform.includes("Mac");
    const actions: ContextMenuAction[] = [];

    const parsed = parseObjectId(id);
    const canDuplicate = parsed?.kind === "furniture" || parsed?.kind === "usb";
    if (canDuplicate) {
      actions.push({
        label: t("roomMap:contextMenu.duplicate"),
        shortcut: isMac ? "\u2318D" : "Ctrl+D",
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
          setSelectedId(id);
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

    actions.push({
      label: t("roomMap:contextMenu.delete"),
      shortcut: isMac ? "\u232B" : "Del",
      danger: true,
      onClick: () => deleteById(id),
    });

    return actions;
  }, [contextMenu, t, handleDuplicate, handleRotate, deleteById, config.furniture, config.imageLayers, handleRenameFurniture]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <span className="text-sm text-zinc-500">Loading...</span>
      </div>
    );
  }

  // Show template selector for empty maps with no edit history
  if (isEmpty && !canUndo) {
    return <TemplateSelector onSelect={(tmpl) => void replaceConfig(tmpl)} />;
  }

  return (
    <div
      className="flex h-full flex-col"
      onKeyDown={handleKeyDown}
      onContextMenu={handleContextMenu}
      tabIndex={0}
      style={{ outline: "none" }}
    >
      <RoomMapToolbar
        hasTv={hasTv}
        hasUsb={hasUsb}
        derivePreviewActive={derivePreviewActive}
        zoneCount={config.zones.length}
        onDeriveZones={handleDeriveZones}
        onAddZone={handleAddHueZone}
        settingsOpen={settingsOpen}
        onToggleSettings={() => setSettingsOpen((v) => !v)}
        canUndo={canUndo}
        canRedo={canRedo}
        onUndo={() => void undo()}
        onRedo={() => void redo()}
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
            onAddHue={handleAddHue}
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
              onReset={() => void resetConfig()}
            />
          )}
          <RoomMapCanvas
            config={config}
            pxPerMeter={pxPerMeter}
            showGrid={showGrid}
            gridStrokeWidth={gridStrokeWidth}
            selectedId={selectedId}
            onCanvasClick={() => setSelectedId(null)}
            onImageLayerTransformChange={(id, ox, oy, s, sx, sy) => {
              void updateConfig({
                imageLayers: config.imageLayers.map((l) =>
                  l.id === id ? { ...l, offsetX: ox, offsetY: oy, scale: s, ...(sx != null ? { scaleX: sx } : {}), ...(sy != null ? { scaleY: sy } : {}) } : l,
                ),
              });
            }}
            onImageLayerSelect={(id) => setSelectedId(imageLayerObjectId(id))}
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
                onSelect={(id) => setSelectedId(usbStripObjectId(id))}
                onChange={(updated) => {
                  const next = config.usbStrips.map((s) =>
                    s.stripId === updated.stripId ? updated : s,
                  );
                  void updateConfig({ usbStrips: next });
                }}
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
                onSelect={(id) => setSelectedId(furnitureObjectId(id))}
                onChange={(updated) => {
                  const next = config.furniture.map((item) =>
                    item.id === updated.id ? updated : item,
                  );
                  void updateConfig({ furniture: next });
                }}
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
                onSelect={() => setSelectedId(TV_ANCHOR_OBJECT_ID)}
                onChange={(updated) => void updateConfig({ tvAnchor: updated })}
                onSnapDragMove={snapDragMove}
                onSnapDragEnd={snapDragEnd}
              />
            )}

            {/* Hue channel dots + zone bounds — bug #53: bounds box must
                render even when no channels exist yet so the user can
                author a zone before the area is paired. W4-J #3: also
                mount whenever the user has at least one Hue zone AND
                the visibility toggle is on, so passive zones paint
                without needing an active selection. */}
            {(
              config.hueChannels.length > 0
              || activeHueZone !== null
              || (showHueZones && hueZones.length > 0)
            ) && (
              <HueChannelOverlay
                channels={config.hueChannels}
                pxPerMeter={pxPerMeter}
                roomWidthM={widthMeters}
                roomDepthM={depthMeters}
                zoom={zoom}
                selectedId={selectedId}
                onSelect={(idx) => setSelectedId(hueChannelObjectId(idx))}
                onChange={(updated) => {
                  const next = config.hueChannels.map((ch) =>
                    ch.channelIndex === updated.channelIndex ? updated : ch,
                  );
                  void updateConfig({ hueChannels: next });
                }}
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
            config={config}
            selectedId={selectedId}
            onSelect={handleSelectObject}
            onDelete={deleteById}
            onRenameFurniture={handleRenameFurniture}
            onToggleLock={(id) => {
              const parsed = parseObjectId(id);
              if (parsed?.kind === "tv" && config.tvAnchor) {
                void updateConfig({ tvAnchor: { ...config.tvAnchor, locked: !config.tvAnchor.locked } });
              } else if (parsed?.kind === "furniture") {
                void updateConfig({ furniture: config.furniture.map((f) => (f.id === parsed.furnitureId ? { ...f, locked: !f.locked } : f)) });
              } else if (parsed?.kind === "usb") {
                void updateConfig({ usbStrips: config.usbStrips.map((s) => (s.stripId === parsed.stripId ? { ...s, locked: !s.locked } : s)) });
              } else if (parsed?.kind === "hue") {
                void updateConfig({ hueChannels: config.hueChannels.map((ch) => (ch.channelIndex === parsed.channelIndex ? { ...ch, locked: !ch.locked } : ch)) });
              } else if (parsed?.kind === "image") {
                void updateConfig({ imageLayers: config.imageLayers.map((l) => (l.id === parsed.layerId ? { ...l, locked: !l.locked } : l)) });
              }
            }}
            hueZones={hueZones}
            activeHueZoneId={activeHueZoneId}
            onSelectHueZone={handleSelectHueZone}
            onAddHueZone={handleAddHueZone}
            onDeleteHueZone={handleDeleteHueZone}
            onRenameHueZone={handleRenameHueZone}
            onUpdateHueZone={handleHueZoneUpdate}
            addHueZoneDisabled={!hueAreaId}
            addHueZoneDisabledTooltip={t("roomMap:hueZones.addDisabledTooltip")}
            hueBridgeConfigured={hueBridgeConfigured}
            hueAreaId={hueAreaId}
            onAssignChannelToZone={handleAssignChannelToZone}
            onNavigateToDevices={onNavigateToDevices}
            // Wave 4-D — type-aware inspector patch hooks
            onUpdateTvAnchor={(patch) => {
              if (!config.tvAnchor) return;
              void updateConfig({ tvAnchor: { ...config.tvAnchor, ...patch } });
            }}
            onUpdateFurniture={(id, patch) => {
              void updateConfig({
                furniture: config.furniture.map((f) =>
                  f.id === id ? { ...f, ...patch } : f,
                ),
              });
            }}
            onUpdateUsbStrip={(stripId, patch) => {
              void updateConfig({
                usbStrips: config.usbStrips.map((s) =>
                  s.stripId === stripId ? { ...s, ...patch } : s,
                ),
              });
            }}
            onUpdateImageLayer={(id, patch) => {
              void updateConfig({
                imageLayers: config.imageLayers.map((l) =>
                  l.id === id ? { ...l, ...patch } : l,
                ),
              });
            }}
            onRenameHueChannel={(channelIndex, label) => {
              void updateConfig({
                hueChannels: config.hueChannels.map((ch) =>
                  ch.channelIndex === channelIndex ? { ...ch, label } : ch,
                ),
              });
            }}
            onRenameImageLayer={handleRenameImage}
            // Wave 4-E — USB connection status feed for inspectors
            usbConnectedPort={usb.connectedPort}
            usbConnectionStatus={usbConnectionStatus}
            onUsbManage={handleManageUsb}
            // Wave 4-G #4 — Hue reachability mirror (parallel to the
            // USB connection status above). Drives the channel inspector
            // chip and Hue zone row dim-state.
            hueChannelStatus={hueChannelStatus}
          />
        )}
      </div>

      {/* Property bar */}
      <PropertyBar
        config={config}
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
        <div className="px-3 py-1.5 text-[11px] text-red-500">
          {t("roomMap:persistError")}
        </div>
      )}
    </div>
  );
}
