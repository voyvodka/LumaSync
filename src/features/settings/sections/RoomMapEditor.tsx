import { useState, useCallback, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { useRoomMapPersist } from "./room-map/useRoomMapPersist";
import { RoomMapCanvas } from "./room-map/RoomMapCanvas";
import { RoomMapToolbar } from "./room-map/RoomMapToolbar";
import { RoomMapSettingsPopover } from "./room-map/RoomMapSettingsPopover";
import { RoomMapEmptyHint } from "./room-map/RoomMapEmptyHint";
import { FurnitureObject } from "./room-map/FurnitureObject";
import { TvAnchorObject } from "./room-map/TvAnchorObject";
import { UsbStripObject } from "./room-map/UsbStripObject";
import { HueChannelOverlay } from "./room-map/HueChannelOverlay";
import { deriveZones, type ZoneDeriveResult } from "./room-map/deriveZones";
import { ZoneDeriveOverlay } from "./room-map/ZoneDeriveOverlay";
import type {
  FurniturePlacement,
  TvAnchorPlacement,
  UsbStripPlacement,
  HueChannelPlacement,
  RoomDimensions,
} from "../../../shared/contracts/roomMap";
import type { LedSegmentCounts } from "../../calibration/model/contracts";

interface RoomMapEditorProps {
  onZoneCountsConfirmed?: (counts: LedSegmentCounts) => void;
}

export function RoomMapEditor({ onZoneCountsConfirmed }: RoomMapEditorProps = {}) {
  const { t } = useTranslation("common");
  const { config, updateConfig, resetConfig, loading, error } = useRoomMapPersist();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [derivePreview, setDerivePreview] = useState<ZoneDeriveResult | null>(null);
  const [showGrid, setShowGrid] = useState(true);
  const [gridStrokeWidth, setGridStrokeWidth] = useState(0.5);
  const [backgroundOpacity, setBackgroundOpacity] = useState(35);
  const [canvasSize, setCanvasSize] = useState({ w: 0, h: 0 });
  const canvasContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = canvasContainerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        setCanvasSize({ w: width, h: height });
      }
    });
    ro.observe(el);
    const rect = el.getBoundingClientRect();
    setCanvasSize({ w: rect.width, h: rect.height });
    return () => ro.disconnect();
  }, []);

  // Derived
  const hasTv = !!config.tvAnchor;
  const hasUsb = config.usbStrips.length > 0;
  const derivePreviewActive = derivePreview !== null;
  const isEmpty =
    !config.tvAnchor &&
    config.furniture.length === 0 &&
    config.usbStrips.length === 0 &&
    config.hueChannels.length === 0;
  const backgroundFileName = config.backgroundImagePath
    ? (config.backgroundImagePath.split("/").pop() ?? null)
    : null;

  const { widthMeters, depthMeters } = config.dimensions;

  // pxPerMeter computed from container size and room dimensions
  const pxPerMeter =
    canvasSize.w > 0 && canvasSize.h > 0
      ? Math.min(canvasSize.w / widthMeters, canvasSize.h / depthMeters)
      : 100;
  const gridStepM = widthMeters < 4 ? 0.5 : 1.0;
  const gridStepPx = gridStepM * pxPerMeter;

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

  // Handlers
  const handleAddTv = useCallback(() => {
    const newTv: TvAnchorPlacement = {
      x: widthMeters / 2 - 0.5,
      y: 0.3,
      width: 1.0,
      height: 0.1,
    };
    void updateConfig({ tvAnchor: newTv });
  }, [widthMeters, updateConfig]);

  const handleAddFurniture = useCallback(
    (type: FurniturePlacement["type"]) => {
      const id = `furniture-${crypto.randomUUID()}`;
      const newItem: FurniturePlacement = {
        id,
        type,
        x: widthMeters / 2 - 0.3,
        y: depthMeters / 2 - 0.3,
        width: 0.6,
        height: 0.6,
        label: t(`roomMap.furniture.type.${type}`),
      };
      void updateConfig({ furniture: [...config.furniture, newItem] });
    },
    [widthMeters, depthMeters, config.furniture, updateConfig, t],
  );

  const handleAddUsb = useCallback(() => {
    const stripId = `usb-${crypto.randomUUID()}`;
    const newStrip: UsbStripPlacement = {
      stripId,
      startX: 1,
      startY: 1,
      endX: widthMeters - 1,
      endY: 1,
      ledCount: 60,
    };
    void updateConfig({ usbStrips: [...config.usbStrips, newStrip] });
  }, [widthMeters, config.usbStrips, updateConfig]);

  const handleAddHue = useCallback(() => {
    const newChannel: HueChannelPlacement = {
      channelIndex: config.hueChannels.length,
      x: 0,
      y: 0,
      z: 0,
    };
    void updateConfig({ hueChannels: [...config.hueChannels, newChannel] });
  }, [config.hueChannels, updateConfig]);

  const handleUploadBackground = useCallback(async () => {
    const selected = await open({
      multiple: false,
      filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg"] }],
    });
    if (selected && typeof selected === "string") {
      const destPath = await invoke<string>("copy_background_image", { srcPath: selected });
      await updateConfig({ backgroundImagePath: destPath });
    }
  }, [updateConfig]);

  const handleDelete = useCallback(() => {
    if (!selectedId) return;
    if (selectedId === "tv") {
      void updateConfig({ tvAnchor: undefined });
    } else if (selectedId.startsWith("furniture-")) {
      const fId = selectedId.replace("furniture-", "");
      void updateConfig({ furniture: config.furniture.filter((f) => f.id !== fId) });
    } else if (selectedId.startsWith("usb-")) {
      const sId = selectedId.replace("usb-", "");
      void updateConfig({ usbStrips: config.usbStrips.filter((s) => s.stripId !== sId) });
    } else if (selectedId.startsWith("hue-")) {
      const idx = parseInt(selectedId.replace("hue-", ""), 10);
      void updateConfig({ hueChannels: config.hueChannels.filter((_, i) => i !== idx) });
    }
    setSelectedId(null);
  }, [selectedId, config, updateConfig]);

  const handleRotate = useCallback(() => {
    if (!selectedId || !selectedId.startsWith("furniture-")) return;
    const fId = selectedId.replace("furniture-", "");
    const updated = config.furniture.map((f) => {
      if (f.id !== fId) return f;
      const current = f.rotation ?? 0;
      return { ...f, rotation: (current + 15) % 360 };
    });
    void updateConfig({ furniture: updated });
  }, [selectedId, config.furniture, updateConfig]);

  const handleArrowNudge = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (!selectedId) return;
      const arrowKeys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"];
      if (!arrowKeys.includes(e.key)) return;
      e.preventDefault();

      // Metre-based nudge step (0.1m default, smaller than grid step)
      const nudgeM = 0.1;
      let dx = 0;
      let dy = 0;
      if (e.key === "ArrowLeft") dx = -nudgeM;
      if (e.key === "ArrowRight") dx = nudgeM;
      if (e.key === "ArrowUp") dy = -nudgeM;
      if (e.key === "ArrowDown") dy = nudgeM;

      if (selectedId === "tv" && config.tvAnchor) {
        void updateConfig({
          tvAnchor: { ...config.tvAnchor, x: config.tvAnchor.x + dx, y: config.tvAnchor.y + dy },
        });
      } else if (selectedId.startsWith("furniture-")) {
        const fId = selectedId.replace("furniture-", "");
        void updateConfig({
          furniture: config.furniture.map((f) =>
            f.id === fId ? { ...f, x: f.x + dx, y: f.y + dy } : f,
          ),
        });
      } else if (selectedId.startsWith("usb-")) {
        const sId = selectedId.replace("usb-", "");
        void updateConfig({
          usbStrips: config.usbStrips.map((s) =>
            s.stripId === sId
              ? { ...s, startX: s.startX + dx, startY: s.startY + dy, endX: s.endX + dx, endY: s.endY + dy }
              : s,
          ),
        });
      } else if (selectedId.startsWith("hue-")) {
        const idx = parseInt(selectedId.replace("hue-", ""), 10);
        // Hue channels: nudge in [-1,1] space; step = 0.05
        const hueStep = 0.05;
        let hdx = 0;
        let hdy = 0;
        if (e.key === "ArrowLeft") hdx = -hueStep;
        if (e.key === "ArrowRight") hdx = hueStep;
        // Hue Y: up = positive (towards front), CSS up = negative
        if (e.key === "ArrowUp") hdy = hueStep;
        if (e.key === "ArrowDown") hdy = -hueStep;
        void updateConfig({
          hueChannels: config.hueChannels.map((ch) =>
            ch.channelIndex === idx
              ? { ...ch, x: Math.max(-1, Math.min(1, ch.x + hdx)), y: Math.max(-1, Math.min(1, ch.y + hdy)) }
              : ch,
          ),
        });
      }
    },
    [selectedId, config, updateConfig],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === "Delete" || e.key === "Backspace") {
        handleDelete();
      } else if (e.key === "r" || e.key === "R") {
        handleRotate();
      } else {
        handleArrowNudge(e);
      }
    },
    [handleDelete, handleRotate, handleArrowNudge],
  );

  const handleDimensionsChange = useCallback(
    (d: RoomDimensions) => {
      void updateConfig({ dimensions: d });
    },
    [updateConfig],
  );

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <span className="text-sm text-slate-400 dark:text-zinc-500">Loading...</span>
      </div>
    );
  }

  return (
    <div
      className="flex h-full flex-col"
      onKeyDown={handleKeyDown}
      tabIndex={0}
      style={{ outline: "none" }}
    >
      <RoomMapToolbar
        hasTv={hasTv}
        hasUsb={hasUsb}
        derivePreviewActive={derivePreviewActive}
        zoneCount={config.zones.length}
        onDeriveZones={handleDeriveZones}
        onAddZone={() => { /* will be wired in Plan 03 */ }}
        onAddTv={handleAddTv}
        onAddFurniture={handleAddFurniture}
        onAddUsb={handleAddUsb}
        onAddHue={handleAddHue}
        settingsOpen={settingsOpen}
        onToggleSettings={() => setSettingsOpen((v) => !v)}
      />
      <div className="relative flex-1" ref={canvasContainerRef}>
        {settingsOpen && (
          <RoomMapSettingsPopover
            open={settingsOpen}
            onClose={() => setSettingsOpen(false)}
            dimensions={config.dimensions}
            showGrid={showGrid}
            backgroundOpacity={backgroundOpacity}
            backgroundFileName={backgroundFileName}
            onDimensionsChange={handleDimensionsChange}
            gridStrokeWidth={gridStrokeWidth}
            onGridToggle={setShowGrid}
            onGridStrokeWidthChange={setGridStrokeWidth}
            onOpacityChange={setBackgroundOpacity}
            onUploadBackground={() => void handleUploadBackground()}
            onReset={() => void resetConfig()}
          />
        )}
        <RoomMapCanvas
          config={config}
          showGrid={showGrid}
          gridStrokeWidth={gridStrokeWidth}
          backgroundOpacity={backgroundOpacity}
          selectedId={selectedId}
          onCanvasClick={() => setSelectedId(null)}
          onBackgroundTransformChange={(ox, oy, s) => {
            void updateConfig({ backgroundOffsetX: ox, backgroundOffsetY: oy, backgroundScale: s });
          }}
        >
          {isEmpty && <RoomMapEmptyHint />}

          {/* USB strip SVG overlay + handles */}
          {config.usbStrips.map((strip) => (
            <UsbStripObject
              key={strip.stripId}
              placement={strip}
              pxPerMeter={pxPerMeter}
              selected={selectedId === `usb-${strip.stripId}`}
              onSelect={(id) => setSelectedId(`usb-${id}`)}
              onChange={(updated) => {
                const next = config.usbStrips.map((s) =>
                  s.stripId === updated.stripId ? updated : s,
                );
                void updateConfig({ usbStrips: next });
              }}
            />
          ))}

          {/* Furniture objects */}
          {config.furniture.map((f) => (
            <FurnitureObject
              key={f.id}
              placement={f}
              pxPerMeter={pxPerMeter}
              selected={selectedId === `furniture-${f.id}`}
              gridStepPx={gridStepPx}
              snapEnabled={showGrid}
              onSelect={(id) => setSelectedId(`furniture-${id}`)}
              onChange={(updated) => {
                const next = config.furniture.map((item) =>
                  item.id === updated.id ? updated : item,
                );
                void updateConfig({ furniture: next });
              }}
            />
          ))}

          {/* TV anchor */}
          {config.tvAnchor && (
            <TvAnchorObject
              placement={config.tvAnchor}
              pxPerMeter={pxPerMeter}
              selected={selectedId === "tv"}
              gridStepPx={gridStepPx}
              snapEnabled={showGrid}
              onSelect={() => setSelectedId("tv")}
              onChange={(updated) => void updateConfig({ tvAnchor: updated })}
            />
          )}

          {/* Hue channel dots */}
          {config.hueChannels.length > 0 && (
            <HueChannelOverlay
              channels={config.hueChannels}
              canvasSize={canvasSize}
              selectedId={selectedId}
              onSelect={(idx) => setSelectedId(`hue-${idx}`)}
              onChange={(updated) => {
                const next = config.hueChannels.map((ch) =>
                  ch.channelIndex === updated.channelIndex ? updated : ch,
                );
                void updateConfig({ hueChannels: next });
              }}
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
        </RoomMapCanvas>
      </div>
      {error && (
        <div className="px-3 py-1.5 text-[11px] text-red-500">
          {t("roomMap.persistError")}
        </div>
      )}
    </div>
  );
}
