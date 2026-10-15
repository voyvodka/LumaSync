import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import type {
  FurniturePlacement,
  RoomMapConfig,
  TvAnchorPlacement,
  UsbStripPlacement,
} from "@/shared/contracts/roomMap";
import { resolveFurnitureType, resolveRoomFootprint } from "@/shared/contracts/roomMap";
import { FURNITURE_DEFAULT_SIZE } from "../model/furnitureKinds";
import { freeSpotFor } from "../model/pieceGeometry";
import { outsideOutline } from "../model/roomFootprint";
import { furnitureObjectId, parseObjectId, TV_ANCHOR_OBJECT_ID, usbStripObjectId } from "../model/objectId";
import { roomObjectAdapter, type NudgeDirection } from "../model/roomObjectKinds";
import type { ApplyOptions } from "./useRoomMapState";
import type { RoomMapPatch } from "./roomMapReducer";

const ARROW_DIRECTIONS: Partial<Record<string, Omit<NudgeDirection, "coarse">>> = {
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
  ArrowUp: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 },
};

export interface UseRoomMapObjectsArgs {
  config: RoomMapConfig;
  /** The entertainment area the editor shows; Hue channel ids resolve inside it. */
  hueAreaId: string | null;
  apply: (patch: RoomMapPatch, options?: ApplyOptions) => void;
  selectedId: string | null;
  select: (objectId: string | null) => void;
}

export interface UseRoomMapObjectsReturn {
  handleAddTv: () => void;
  handleAddFurniture: (type: FurniturePlacement["type"]) => void;
  handleAddUsb: () => void;
  isLocked: (id: string) => boolean;
  deleteById: (id: string) => void;
  handleDelete: () => void;
  handleRotate: () => void;
  handleDuplicate: (id: string) => void;
  handleArrowNudge: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  handleUpdatePosition: (id: string, x: number, y: number, options?: ApplyOptions) => void;
  /** Renames any kind that takes a name, the viewed area's Hue light included. */
  handleRename: (id: string, label: string) => void;
}

/** Create, delete, duplicate and transform handlers for every non-image object kind. */
export function useRoomMapObjects({
  config,
  hueAreaId,
  apply,
  selectedId,
  select,
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
    apply({ tvAnchor: newTv });
    select(TV_ANCHOR_OBJECT_ID);
  }, [widthMeters, apply, select]);

  const handleAddFurniture = useCallback(
    (type: FurniturePlacement["type"]) => {
      const id = `furniture-${crypto.randomUUID()}`;
      const size = FURNITURE_DEFAULT_SIZE[type];
      // The free place nearest the room's middle: a rug may go under furniture, so it keeps clear of
      // other rugs only; anything else keeps clear of every piece but the rugs, and of the TV.
      const rug = type === "rug";
      const around = [
        ...config.furniture.filter((f) => (resolveFurnitureType(f.type) === "rug") === rug),
        ...(config.tvAnchor && !rug ? [config.tvAnchor] : []),
      ];
      const outline = resolveRoomFootprint(config);
      const spot = freeSpotFor(size.width, size.depth, { width: widthMeters, depth: depthMeters }, around, (px, py) => !outsideOutline(px, py, outline));
      let x = spot?.x ?? widthMeters / 2 - size.width / 2;
      let y = spot?.y ?? depthMeters / 2 - size.depth / 2;
      // A full room: the middle, stepped 30 cm down-right past every piece already sitting there, so
      // a second one added does not land exactly on the first and hide it.
      for (let tries = 0; !spot && tries < 8 && config.furniture.some((f) => Math.abs(f.x - x) < 0.05 && Math.abs(f.y - y) < 0.05); tries++) {
        x = Math.min(x + 0.3, Math.max(0, widthMeters - size.width));
        y = Math.min(y + 0.3, Math.max(0, depthMeters - size.depth));
      }
      const newItem: FurniturePlacement = {
        id,
        type,
        x,
        y,
        width: size.width,
        height: size.depth,
        label: t(`roomMap:furniture.type.${type}`),
      };
      apply({ furniture: [...config.furniture, newItem] });
      select(furnitureObjectId(id));
    },
    [widthMeters, depthMeters, config, apply, select, t],
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
    apply({ usbStrips: [...config.usbStrips, newStrip] });
    select(usbStripObjectId(stripId));
  }, [widthMeters, config.usbStrips, apply, select]);

  const isLocked = useCallback(
    (id: string): boolean => {
      const ref = parseObjectId(id);
      return ref ? roomObjectAdapter(ref).isLocked(config, ref, { hueAreaId }) : false;
    },
    [config, hueAreaId],
  );

  const deleteById = useCallback(
    (id: string) => {
      if (isLocked(id)) return;
      const ref = parseObjectId(id);
      // A kind with no `remove` (Hue channels) only loses the selection.
      const remove = ref ? roomObjectAdapter(ref).remove : null;
      if (ref && remove) apply(remove(config, ref));
      select(null);
    },
    [config, apply, isLocked, select],
  );

  const handleDelete = useCallback(() => {
    if (!selectedId) return;
    deleteById(selectedId);
  }, [selectedId, deleteById]);

  const handleRotate = useCallback(() => {
    if (selectedId && isLocked(selectedId)) return;
    const ref = selectedId ? parseObjectId(selectedId) : null;
    const rotateBy = ref ? roomObjectAdapter(ref).rotateBy : null;
    if (!ref || !rotateBy) return;
    apply(rotateBy(config, ref, 15));
  }, [selectedId, config, apply, isLocked]);

  const handleDuplicate = useCallback(
    (id: string) => {
      const ref = parseObjectId(id);
      const duplicate = ref ? roomObjectAdapter(ref).duplicate : null;
      const result = ref && duplicate ? duplicate(config, ref, 0.2) : null;
      if (!result) return;
      apply(result.patch);
      select(result.objectId);
    },
    [config, apply, select],
  );

  const handleArrowNudge = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (!selectedId || isLocked(selectedId)) return;
      const direction = ARROW_DIRECTIONS[e.key];
      if (!direction) return;
      e.preventDefault();

      const ref = parseObjectId(selectedId);
      const nudge = ref ? roomObjectAdapter(ref).nudge : null;
      if (!ref || !nudge) return;
      // Keyed per object, so a held arrow is one undo step and one save while
      // moving a second object starts a step of its own.
      apply((cfg) => nudge(cfg, ref, { ...direction, coarse: e.shiftKey }, { hueAreaId }), {
        gesture: `nudge:${selectedId}`,
        continued: e.repeat,
      });
    },
    [selectedId, hueAreaId, apply, isLocked],
  );

  const handleUpdatePosition = useCallback(
    (id: string, x: number, y: number, options?: ApplyOptions) => {
      const ref = parseObjectId(id);
      const patch = ref ? roomObjectAdapter(ref).moveTo(config, ref, x, y, { hueAreaId }) : null;
      if (patch) apply(patch, options);
    },
    [config, hueAreaId, apply],
  );

  const handleRename = useCallback(
    (id: string, label: string) => {
      const ref = parseObjectId(id);
      const rename = ref ? roomObjectAdapter(ref).rename : null;
      if (ref && rename) apply(rename(config, ref, label, { hueAreaId }));
    },
    [config, hueAreaId, apply],
  );

  return {
    handleAddTv,
    handleAddFurniture,
    handleAddUsb,
    isLocked,
    deleteById,
    handleDelete,
    handleRotate,
    handleDuplicate,
    handleArrowNudge,
    handleUpdatePosition,
    handleRename,
  };
}
