import { useCallback, useState } from "react";
import {
  ROOM_MAP_BACKGROUND_ERROR,
  type RoomMapBackgroundErrorCode,
} from "@/shared/contracts/roomMap";
import { imageLayerObjectId } from "../model/objectId";
import { copyBackgroundImage } from "../roomMapApi";
import { pickRoomMapImage } from "../roomMapFilesApi";
import { parseCommandError } from "@/shared/contracts/status";
import type { RoomMapPatch } from "./roomMapReducer";
import type { ApplyOptions } from "./useRoomMapState";

export interface UseRoomMapImageLayersArgs {
  apply: (patch: RoomMapPatch, options?: ApplyOptions) => void;
  select: (objectId: string | null) => void;
}

export interface UseRoomMapImageLayersReturn {
  handleAddImage: () => Promise<void>;
  /** Set when the last import attempt failed; cleared when a new one starts. */
  imageError: string | null;
  /** The coded reason for `imageError`, when the backend gave one the UI words differently. */
  imageErrorCode: RoomMapBackgroundErrorCode | null;
}

/** Shared by every continuous control over one image-layer field — the inspector's slider and
 *  stepped fields, the canvas wheel — so a run of them is one undo step. */
export function imageLayerGestureKey(imageId: string, field: string): string {
  return `image:${imageId}:${field}`;
}

/** Background image layer import; the inspector patches the rest. */
export function useRoomMapImageLayers({
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

  return {
    handleAddImage,
    imageError,
    imageErrorCode,
  };
}
