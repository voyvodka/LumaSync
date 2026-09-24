import { useCallback, useState } from "react";
import {
  ROOM_MAP_BACKGROUND_ERROR,
  type RoomMapBackgroundErrorCode,
  type RoomMapConfig,
} from "@/shared/contracts/roomMap";
import { imageLayerObjectId } from "../model/objectId";
import { copyBackgroundImage } from "../roomMapApi";
import { pickRoomMapImage } from "../roomMapFilesApi";
import { parseCommandError } from "@/shared/contracts/status";
import type { RoomMapPatch } from "./roomMapReducer";
import type { ApplyOptions } from "./useRoomMapState";

export interface UseRoomMapImageLayersArgs {
  config: RoomMapConfig;
  apply: (patch: RoomMapPatch, options?: ApplyOptions) => void;
  select: (objectId: string | null) => void;
}

export interface UseRoomMapImageLayersReturn {
  handleAddImage: () => Promise<void>;
  /** Set when the last import attempt failed; cleared when a new one starts. */
  imageError: string | null;
  /** The coded reason for `imageError`, when the backend gave one the UI words differently. */
  imageErrorCode: RoomMapBackgroundErrorCode | null;
  handleUpdateImageOpacity: (imageId: string, opacity: number) => void;
  handleUpdateImageScale: (imageId: string, sx: number, sy: number) => void;
  handleUpdateImageAspectLock: (imageId: string, locked: boolean) => void;
  handleResetImageScale: (imageId: string) => void;
  handleRenameImage: (imageId: string, label: string) => void;
}

/** Shared by every continuous control over one image-layer field, so the dock
 *  slider and the property-bar slider coalesce into the same undo step. */
export function imageLayerGestureKey(imageId: string, field: string): string {
  return `image:${imageId}:${field}`;
}

/** Background image layer import plus the opacity / scale / rename handlers. */
export function useRoomMapImageLayers({
  config,
  apply,
  select,
}: UseRoomMapImageLayersArgs): UseRoomMapImageLayersReturn {
  const [imageError, setImageError] = useState<string | null>(null);
  const [imageErrorCode, setImageErrorCode] = useState<RoomMapBackgroundErrorCode | null>(null);

  const handleAddImage = useCallback(async () => {
    setImageError(null);
    setImageErrorCode(null);
    try {
      const selected = await pickRoomMapImage();
      if (selected && typeof selected === "string") {
        const destPath = await copyBackgroundImage(selected);
        const fileName = destPath.split("/").pop() ?? "Image";
        const label = fileName.replace(/\.[^.]+$/, "");
        const id = crypto.randomUUID();
        const newLayer = { id, path: destPath, label, offsetX: 0, offsetY: 0, scale: 1 };
        // The dialog was open for as long as the user liked; read the map as it is now.
        apply((cfg) => ({ imageLayers: [...cfg.imageLayers, newLayer] }));
        select(imageLayerObjectId(id));
      }
    } catch (err) {
      const parsed = parseCommandError(err);
      console.error(`[LumaSync] Room map image import failed: ${parsed.message}`);
      setImageError(parsed.message);
      setImageErrorCode(parsed.code === ROOM_MAP_BACKGROUND_ERROR.TOO_LARGE ? parsed.code : null);
    }
  }, [apply, select]);

  const handleUpdateImageOpacity = useCallback(
    (imageId: string, opacity: number) => {
      // A slider: every tick lands, but the drag is one undo step and one save.
      apply(
        { imageLayers: config.imageLayers.map((l) => (l.id === imageId ? { ...l, opacity } : l)) },
        { gesture: imageLayerGestureKey(imageId, "opacity") },
      );
    },
    [config.imageLayers, apply],
  );

  const handleUpdateImageScale = useCallback(
    (imageId: string, sx: number, sy: number) => {
      apply({ imageLayers: config.imageLayers.map((l) => (l.id === imageId ? { ...l, scaleX: sx, scaleY: sy } : l)) });
    },
    [config.imageLayers, apply],
  );

  const handleUpdateImageAspectLock = useCallback(
    (imageId: string, locked: boolean) => {
      // Just toggle the flag — keep current scaleX/scaleY as-is
      apply({ imageLayers: config.imageLayers.map((l) => (l.id === imageId ? { ...l, aspectLocked: locked } : l)) });
    },
    [config.imageLayers, apply],
  );

  const handleResetImageScale = useCallback(
    (imageId: string) => {
      const layer = config.imageLayers.find((l) => l.id === imageId);
      if (!layer) return;
      // Reset aspect ratio only — unify scaleY to scaleX, keep current size
      const s = layer.scaleX ?? layer.scale;
      apply({ imageLayers: config.imageLayers.map((l) => (l.id === imageId ? { ...l, scaleX: s, scaleY: s } : l)) });
    },
    [config.imageLayers, apply],
  );

  const handleRenameImage = useCallback(
    (imageId: string, label: string) => {
      apply({
        imageLayers: config.imageLayers.map((l) => (l.id === imageId ? { ...l, label } : l)),
      });
    },
    [config.imageLayers, apply],
  );

  return {
    handleAddImage,
    imageError,
    imageErrorCode,
    handleUpdateImageOpacity,
    handleUpdateImageScale,
    handleUpdateImageAspectLock,
    handleResetImageScale,
    handleRenameImage,
  };
}
