import { useCallback, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import type { RoomMapConfig } from "@/shared/contracts/roomMap";
import { imageLayerObjectId } from "../model/objectId";
import { copyBackgroundImage } from "../roomMapApi";

export interface UseRoomMapImageLayersArgs {
  config: RoomMapConfig;
  updateConfig: (partial: Partial<RoomMapConfig>) => Promise<void>;
  setSelectedId: React.Dispatch<React.SetStateAction<string | null>>;
}

export interface UseRoomMapImageLayersReturn {
  handleAddImage: () => Promise<void>;
  /** Set when the last import attempt failed; cleared when a new one starts. */
  imageError: string | null;
  handleUpdateImageOpacity: (imageId: string, opacity: number) => void;
  handleUpdateImageScale: (imageId: string, sx: number, sy: number) => void;
  handleUpdateImageAspectLock: (imageId: string, locked: boolean) => void;
  handleResetImageScale: (imageId: string) => void;
  handleRenameImage: (imageId: string, label: string) => void;
}

/** Background image layer import plus the opacity / scale / rename handlers. */
export function useRoomMapImageLayers({
  config,
  updateConfig,
  setSelectedId,
}: UseRoomMapImageLayersArgs): UseRoomMapImageLayersReturn {
  const [imageError, setImageError] = useState<string | null>(null);

  const handleAddImage = useCallback(async () => {
    setImageError(null);
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg"] }],
      });
      if (selected && typeof selected === "string") {
        const destPath = await copyBackgroundImage(selected);
        const fileName = destPath.split("/").pop() ?? "Image";
        const label = fileName.replace(/\.[^.]+$/, "");
        const id = crypto.randomUUID();
        const newLayer = { id, path: destPath, label, offsetX: 0, offsetY: 0, scale: 1 };
        await updateConfig({ imageLayers: [...config.imageLayers, newLayer] });
        setSelectedId(imageLayerObjectId(id));
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[LumaSync] Room map image import failed: ${reason}`);
      setImageError(reason);
    }
  }, [config.imageLayers, updateConfig, setSelectedId]);

  const handleUpdateImageOpacity = useCallback(
    (imageId: string, opacity: number) => {
      void updateConfig({ imageLayers: config.imageLayers.map((l) => (l.id === imageId ? { ...l, opacity } : l)) });
    },
    [config.imageLayers, updateConfig],
  );

  const handleUpdateImageScale = useCallback(
    (imageId: string, sx: number, sy: number) => {
      void updateConfig({ imageLayers: config.imageLayers.map((l) => (l.id === imageId ? { ...l, scaleX: sx, scaleY: sy } : l)) });
    },
    [config.imageLayers, updateConfig],
  );

  const handleUpdateImageAspectLock = useCallback(
    (imageId: string, locked: boolean) => {
      // Just toggle the flag — keep current scaleX/scaleY as-is
      void updateConfig({ imageLayers: config.imageLayers.map((l) => (l.id === imageId ? { ...l, aspectLocked: locked } : l)) });
    },
    [config.imageLayers, updateConfig],
  );

  const handleResetImageScale = useCallback(
    (imageId: string) => {
      const layer = config.imageLayers.find((l) => l.id === imageId);
      if (!layer) return;
      // Reset aspect ratio only — unify scaleY to scaleX, keep current size
      const s = layer.scaleX ?? layer.scale;
      void updateConfig({ imageLayers: config.imageLayers.map((l) => (l.id === imageId ? { ...l, scaleX: s, scaleY: s } : l)) });
    },
    [config.imageLayers, updateConfig],
  );

  const handleRenameImage = useCallback(
    (imageId: string, label: string) => {
      void updateConfig({
        imageLayers: config.imageLayers.map((l) => (l.id === imageId ? { ...l, label } : l)),
      });
    },
    [config.imageLayers, updateConfig],
  );

  return {
    handleAddImage,
    imageError,
    handleUpdateImageOpacity,
    handleUpdateImageScale,
    handleUpdateImageAspectLock,
    handleResetImageScale,
    handleRenameImage,
  };
}
