import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import type {
  FurniturePlacement,
  RoomMapConfig,
  TvAnchorPlacement,
  UsbStripPlacement,
} from "@/shared/contracts/roomMap";
import { parseObjectId } from "../model/objectId";
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
  handleUpdatePosition: (id: string, x: number, y: number) => void;
  handleUpdateSize: (id: string, w: number, h: number) => void;
  handleUpdateRotation: (id: string, rotation: number) => void;
  handleRenameFurniture: (id: string, label: string) => void;
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
  }, [widthMeters, apply]);

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
      apply({ furniture: [...config.furniture, newItem] });
    },
    [widthMeters, depthMeters, config.furniture, apply, t],
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
  }, [widthMeters, config.usbStrips, apply]);

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
    (id: string, x: number, y: number) => {
      const ref = parseObjectId(id);
      const patch = ref ? roomObjectAdapter(ref).moveTo(config, ref, x, y, { hueAreaId }) : null;
      if (patch) apply(patch);
    },
    [config, hueAreaId, apply],
  );

  const handleUpdateSize = useCallback(
    (id: string, w: number, h: number) => {
      const ref = parseObjectId(id);
      const resize = ref ? roomObjectAdapter(ref).resize : null;
      const patch = ref && resize ? resize(config, ref, w, h) : null;
      if (patch) apply(patch);
    },
    [config, apply],
  );

  const handleUpdateRotation = useCallback(
    (id: string, rotation: number) => {
      const ref = parseObjectId(id);
      const rotateTo = ref ? roomObjectAdapter(ref).rotateTo : null;
      if (ref && rotateTo) apply(rotateTo(config, ref, rotation));
    },
    [config, apply],
  );

  const handleRenameFurniture = useCallback(
    (id: string, label: string) => {
      apply({
        furniture: config.furniture.map((f) => (f.id === id ? { ...f, label } : f)),
      });
    },
    [config.furniture, apply],
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
    handleUpdateSize,
    handleUpdateRotation,
    handleRenameFurniture,
  };
}
