import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import type {
  FurniturePlacement,
  HueChannelPlacement,
  RoomMapConfig,
  TvAnchorPlacement,
  UsbStripPlacement,
} from "@/shared/contracts/roomMap";
import { findHueChannel, nextHueChannelIndex } from "@/shared/contracts/roomMap";
import { moveHueChannelToWorld, nudgeHueChannel } from "../model/hueChannelPosition";
import {
  furnitureObjectId,
  parseObjectId,
  usbStripObjectId,
} from "../model/objectId";

export interface UseRoomMapObjectsArgs {
  config: RoomMapConfig;
  updateConfig: (partial: Partial<RoomMapConfig>) => Promise<void>;
  selectedId: string | null;
  setSelectedId: React.Dispatch<React.SetStateAction<string | null>>;
}

export interface UseRoomMapObjectsReturn {
  handleAddTv: () => void;
  handleAddFurniture: (type: FurniturePlacement["type"]) => void;
  handleAddUsb: () => void;
  handleAddHue: () => void;
  isLocked: (id: string) => boolean;
  deleteById: (id: string) => void;
  handleDelete: () => void;
  handleRotate: () => void;
  handleDuplicate: (id: string) => void;
  handleArrowNudge: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  handleUpdatePosition: (id: string, x: number, y: number) => void;
  handleUpdateSize: (id: string, w: number, h: number) => void;
  handleUpdateRotation: (id: string, rotation: number) => void;
  handleRenameFurniture: (id: string, label: string) => void;
}

/** Create, delete, duplicate and transform handlers for every non-image object kind. */
export function useRoomMapObjects({
  config,
  updateConfig,
  selectedId,
  setSelectedId,
}: UseRoomMapObjectsArgs): UseRoomMapObjectsReturn {
  const { t } = useTranslation();
  const { widthMeters, depthMeters } = config.dimensions;

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
        label: t(`roomMap:furniture.type.${type}`),
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
      channelIndex: nextHueChannelIndex(config.hueChannels),
      x: 0,
      y: 0,
      z: 0,
    };
    void updateConfig({ hueChannels: [...config.hueChannels, newChannel] });
  }, [config.hueChannels, updateConfig]);

  const isLocked = useCallback(
    (id: string): boolean => {
      const parsed = parseObjectId(id);
      if (parsed?.kind === "tv") return !!config.tvAnchor?.locked;
      if (parsed?.kind === "furniture") return !!config.furniture.find((f) => f.id === parsed.furnitureId)?.locked;
      if (parsed?.kind === "usb") return !!config.usbStrips.find((s) => s.stripId === parsed.stripId)?.locked;
      if (parsed?.kind === "hue") return !!findHueChannel(config.hueChannels, parsed.channelIndex)?.locked;
      if (parsed?.kind === "image") return !!config.imageLayers.find((l) => l.id === parsed.layerId)?.locked;
      return false;
    },
    [config],
  );

  const deleteById = useCallback(
    (id: string) => {
      if (isLocked(id)) return;
      const parsed = parseObjectId(id);
      if (parsed?.kind === "image") {
        void updateConfig({ imageLayers: config.imageLayers.filter((l) => l.id !== parsed.layerId) });
      } else if (parsed?.kind === "tv") {
        void updateConfig({ tvAnchor: undefined });
      } else if (parsed?.kind === "furniture") {
        void updateConfig({ furniture: config.furniture.filter((f) => f.id !== parsed.furnitureId) });
      } else if (parsed?.kind === "usb") {
        void updateConfig({ usbStrips: config.usbStrips.filter((s) => s.stripId !== parsed.stripId) });
      }
      // No Hue-channel branch here on purpose — channels are bridge-managed and
      // detaching goes through "Move to → Unassigned". See
      // docs/architecture/room-map.md for the bug that removing one caused.
      setSelectedId(null);
    },
    [config, updateConfig, isLocked, setSelectedId],
  );

  const handleDelete = useCallback(() => {
    if (!selectedId) return;
    deleteById(selectedId);
  }, [selectedId, deleteById]);

  const handleRotate = useCallback(() => {
    if (selectedId && isLocked(selectedId)) return;
    const parsed = selectedId ? parseObjectId(selectedId) : null;
    if (parsed?.kind !== "furniture") return;
    const updated = config.furniture.map((f) => {
      if (f.id !== parsed.furnitureId) return f;
      const current = f.rotation ?? 0;
      return { ...f, rotation: (current + 15) % 360 };
    });
    void updateConfig({ furniture: updated });
  }, [selectedId, config.furniture, updateConfig, isLocked]);

  const handleDuplicate = useCallback(
    (id: string) => {
      const offset = 0.2;
      const parsed = parseObjectId(id);
      if (parsed?.kind === "furniture") {
        const src = config.furniture.find((f) => f.id === parsed.furnitureId);
        if (!src) return;
        const dup = { ...src, id: crypto.randomUUID(), x: src.x + offset, y: src.y + offset };
        void updateConfig({ furniture: [...config.furniture, dup] });
        setSelectedId(furnitureObjectId(dup.id));
      } else if (parsed?.kind === "usb") {
        const src = config.usbStrips.find((s) => s.stripId === parsed.stripId);
        if (!src) return;
        const dup = { ...src, stripId: crypto.randomUUID(), startX: src.startX + offset, startY: src.startY + offset, endX: src.endX + offset, endY: src.endY + offset };
        void updateConfig({ usbStrips: [...config.usbStrips, dup] });
        setSelectedId(usbStripObjectId(dup.stripId));
      }
    },
    [config.furniture, config.usbStrips, updateConfig, setSelectedId],
  );

  const handleArrowNudge = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (!selectedId || isLocked(selectedId)) return;
      const arrowKeys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"];
      if (!arrowKeys.includes(e.key)) return;
      e.preventDefault();

      // Metre-based nudge step (0.1m default, 1.0m with Shift)
      const nudgeM = e.shiftKey ? 1.0 : 0.1;
      let dx = 0;
      let dy = 0;
      if (e.key === "ArrowLeft") dx = -nudgeM;
      if (e.key === "ArrowRight") dx = nudgeM;
      if (e.key === "ArrowUp") dy = -nudgeM;
      if (e.key === "ArrowDown") dy = nudgeM;

      const parsed = parseObjectId(selectedId);
      if (parsed?.kind === "tv" && config.tvAnchor) {
        void updateConfig({
          tvAnchor: { ...config.tvAnchor, x: config.tvAnchor.x + dx, y: config.tvAnchor.y + dy },
        });
      } else if (parsed?.kind === "furniture") {
        void updateConfig({
          furniture: config.furniture.map((f) =>
            f.id === parsed.furnitureId ? { ...f, x: f.x + dx, y: f.y + dy } : f,
          ),
        });
      } else if (parsed?.kind === "usb") {
        void updateConfig({
          usbStrips: config.usbStrips.map((s) =>
            s.stripId === parsed.stripId
              ? { ...s, startX: s.startX + dx, startY: s.startY + dy, endX: s.endX + dx, endY: s.endY + dy }
              : s,
          ),
        });
      } else if (parsed?.kind === "hue") {
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
            ch.channelIndex === parsed.channelIndex
              ? nudgeHueChannel(ch, config.zones, hdx, hdy)
              : ch,
          ),
        });
      }
    },
    [selectedId, config, updateConfig, isLocked],
  );

  const handleUpdatePosition = useCallback(
    (id: string, x: number, y: number) => {
      const parsed = parseObjectId(id);
      if (parsed?.kind === "tv" && config.tvAnchor) {
        void updateConfig({ tvAnchor: { ...config.tvAnchor, x, y } });
      } else if (parsed?.kind === "furniture") {
        void updateConfig({ furniture: config.furniture.map((f) => (f.id === parsed.furnitureId ? { ...f, x, y } : f)) });
      } else if (parsed?.kind === "usb") {
        void updateConfig({
          usbStrips: config.usbStrips.map((s) => {
            if (s.stripId !== parsed.stripId) return s;
            const dx = x - s.startX;
            const dy = y - s.startY;
            return { ...s, startX: x, startY: y, endX: s.endX + dx, endY: s.endY + dy };
          }),
        });
      } else if (parsed?.kind === "hue") {
        void updateConfig({
          hueChannels: config.hueChannels.map((ch) =>
            ch.channelIndex === parsed.channelIndex
              ? moveHueChannelToWorld(ch, config.zones, x, y)
              : ch,
          ),
        });
      } else if (parsed?.kind === "image") {
        void updateConfig({ imageLayers: config.imageLayers.map((l) => (l.id === parsed.layerId ? { ...l, offsetX: x, offsetY: y } : l)) });
      }
    },
    [config, updateConfig],
  );

  const handleUpdateSize = useCallback(
    (id: string, w: number, h: number) => {
      const parsed = parseObjectId(id);
      if (parsed?.kind === "tv" && config.tvAnchor) {
        void updateConfig({ tvAnchor: { ...config.tvAnchor, width: w, height: h } });
      } else if (parsed?.kind === "furniture") {
        void updateConfig({ furniture: config.furniture.map((f) => (f.id === parsed.furnitureId ? { ...f, width: w, height: h } : f)) });
      }
    },
    [config, updateConfig],
  );

  const handleUpdateRotation = useCallback(
    (id: string, rotation: number) => {
      const parsed = parseObjectId(id);
      if (parsed?.kind === "furniture") {
        void updateConfig({ furniture: config.furniture.map((f) => (f.id === parsed.furnitureId ? { ...f, rotation } : f)) });
      }
    },
    [config.furniture, updateConfig],
  );

  const handleRenameFurniture = useCallback(
    (id: string, label: string) => {
      void updateConfig({
        furniture: config.furniture.map((f) => (f.id === id ? { ...f, label } : f)),
      });
    },
    [config.furniture, updateConfig],
  );

  return {
    handleAddTv,
    handleAddFurniture,
    handleAddUsb,
    handleAddHue,
    isLocked,
    deleteById,
    handleDelete,
    handleRotate,
    handleDuplicate,
    handleArrowNudge,
    handleUpdatePosition,
    handleUpdateSize,
    handleUpdateRotation,
    handleRenameFurniture,
  };
}
