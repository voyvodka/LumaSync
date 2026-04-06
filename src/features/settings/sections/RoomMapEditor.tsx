import { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { useRoomMapPersist } from "./room-map/useRoomMapPersist";
import { RoomMapCanvas } from "./room-map/RoomMapCanvas";
import { RoomMapToolbar } from "./room-map/RoomMapToolbar";
import { RoomMapSettingsPopover } from "./room-map/RoomMapSettingsPopover";
import { RoomMapEmptyHint } from "./room-map/RoomMapEmptyHint";
import type {
  FurniturePlacement,
  TvAnchorPlacement,
  UsbStripPlacement,
  HueChannelPlacement,
  RoomDimensions,
} from "../../../shared/contracts/roomMap";

export function RoomMapEditor() {
  const { t } = useTranslation("common");
  const { config, updateConfig, resetConfig, loading, error } = useRoomMapPersist();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [showGrid, setShowGrid] = useState(true);
  const [backgroundOpacity, setBackgroundOpacity] = useState(35);

  // Derived
  const hasTv = !!config.tvAnchor;
  const isEmpty =
    !config.tvAnchor &&
    config.furniture.length === 0 &&
    config.usbStrips.length === 0 &&
    config.hueChannels.length === 0;
  const backgroundFileName = config.backgroundImagePath
    ? (config.backgroundImagePath.split("/").pop() ?? null)
    : null;

  const { widthMeters, depthMeters } = config.dimensions;

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
    if (selectedId.startsWith("furniture-")) {
      void updateConfig({ furniture: config.furniture.filter((f) => f.id !== selectedId) });
    } else if (selectedId.startsWith("usb-")) {
      void updateConfig({ usbStrips: config.usbStrips.filter((s) => s.stripId !== selectedId) });
    } else if (selectedId.startsWith("hue-")) {
      const idx = parseInt(selectedId.replace("hue-", ""), 10);
      void updateConfig({ hueChannels: config.hueChannels.filter((_, i) => i !== idx) });
    } else if (selectedId === "tv") {
      void updateConfig({ tvAnchor: undefined });
    }
    setSelectedId(null);
  }, [selectedId, config, updateConfig]);

  const handleRotate = useCallback(() => {
    if (!selectedId || !selectedId.startsWith("furniture-")) return;
    const updated = config.furniture.map((f) => {
      if (f.id !== selectedId) return f;
      const current = f.rotation ?? 0;
      return { ...f, rotation: (current + 15) % 360 };
    });
    void updateConfig({ furniture: updated });
  }, [selectedId, config.furniture, updateConfig]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === "Delete" || e.key === "Backspace") {
        handleDelete();
      } else if (e.key === "r" || e.key === "R") {
        handleRotate();
      }
    },
    [handleDelete, handleRotate],
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
        onAddTv={handleAddTv}
        onAddFurniture={handleAddFurniture}
        onAddUsb={handleAddUsb}
        onAddHue={handleAddHue}
        settingsOpen={settingsOpen}
        onToggleSettings={() => setSettingsOpen((v) => !v)}
      />
      <div className="relative flex-1">
        {settingsOpen && (
          <RoomMapSettingsPopover
            open={settingsOpen}
            onClose={() => setSettingsOpen(false)}
            dimensions={config.dimensions}
            showGrid={showGrid}
            backgroundOpacity={backgroundOpacity}
            backgroundFileName={backgroundFileName}
            onDimensionsChange={handleDimensionsChange}
            onGridToggle={setShowGrid}
            onOpacityChange={setBackgroundOpacity}
            onUploadBackground={() => void handleUploadBackground()}
            onReset={() => void resetConfig()}
          />
        )}
        <RoomMapCanvas
          config={config}
          showGrid={showGrid}
          backgroundOpacity={backgroundOpacity}
          selectedId={selectedId}
          onCanvasClick={() => setSelectedId(null)}
        >
          {isEmpty && <RoomMapEmptyHint />}
          {/* Object components from Plan 03/04 will render here */}
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
