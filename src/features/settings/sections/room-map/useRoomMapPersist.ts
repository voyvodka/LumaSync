import { useState, useEffect, useCallback, useRef } from "react";
import { shellStore } from "../../../persistence/shellStore";
import type { RoomMapConfig } from "../../../../shared/contracts/roomMap";
import { DEFAULT_ROOM_MAP } from "../../../../shared/contracts/roomMap";

const MAX_HISTORY = 50;

export interface UseRoomMapPersistReturn {
  config: RoomMapConfig;
  updateConfig: (partial: Partial<RoomMapConfig>) => Promise<void>;
  replaceConfig: (full: RoomMapConfig) => Promise<void>;
  resetConfig: () => Promise<void>;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  canUndo: boolean;
  canRedo: boolean;
  loading: boolean;
  error: string | null;
}

export function useRoomMapPersist(): UseRoomMapPersistReturn {
  const [config, setConfig] = useState<RoomMapConfig>(DEFAULT_ROOM_MAP);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const versionRef = useRef(0);

  // Undo/redo history — refs to avoid re-render on every push
  const pastRef = useRef<RoomMapConfig[]>([]);
  const futureRef = useRef<RoomMapConfig[]>([]);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  const syncUndoFlags = useCallback(() => {
    setCanUndo(pastRef.current.length > 0);
    setCanRedo(futureRef.current.length > 0);
  }, []);

  useEffect(() => {
    let cancelled = false;
    shellStore
      .load()
      .then((state) => {
        if (cancelled) return;
        if (state.roomMap) {
          const loaded = { ...state.roomMap };
          // Migrate legacy single background → imageLayers
          if (!loaded.imageLayers) loaded.imageLayers = [];
          if (loaded.backgroundImagePath && loaded.imageLayers.length === 0) {
            const fileName = loaded.backgroundImagePath.split("/").pop() ?? "Image";
            const label = fileName.replace(/\.[^.]+$/, "");
            loaded.imageLayers = [{
              id: `img-${crypto.randomUUID()}`,
              path: loaded.backgroundImagePath,
              label,
              offsetX: loaded.backgroundOffsetX ?? 0,
              offsetY: loaded.backgroundOffsetY ?? 0,
              scale: loaded.backgroundScale ?? 1,
            }];
            delete loaded.backgroundImagePath;
            delete loaded.backgroundOffsetX;
            delete loaded.backgroundOffsetY;
            delete loaded.backgroundScale;
          }
          setConfig(loaded);
          versionRef.current = state.roomMapVersion ?? 0;
        }
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(String(err));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const persist = useCallback(async (next: RoomMapConfig) => {
    try {
      versionRef.current += 1;
      await shellStore.save({ roomMap: next, roomMapVersion: versionRef.current });
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }, []);

  const pushHistory = useCallback(
    (current: RoomMapConfig) => {
      pastRef.current = [...pastRef.current.slice(-(MAX_HISTORY - 1)), current];
      futureRef.current = [];
      syncUndoFlags();
    },
    [syncUndoFlags],
  );

  const updateConfig = useCallback(
    async (partial: Partial<RoomMapConfig>) => {
      pushHistory(config);
      const next = { ...config, ...partial };
      setConfig(next);
      await persist(next);
    },
    [config, persist, pushHistory],
  );

  const replaceConfig = useCallback(
    async (full: RoomMapConfig) => {
      pushHistory(config);
      setConfig(full);
      await persist(full);
    },
    [config, persist, pushHistory],
  );

  const resetConfig = useCallback(async () => {
    pushHistory(config);
    setConfig(DEFAULT_ROOM_MAP);
    await persist(DEFAULT_ROOM_MAP);
  }, [config, persist, pushHistory]);

  const undo = useCallback(async () => {
    if (pastRef.current.length === 0) return;
    const previous = pastRef.current[pastRef.current.length - 1];
    pastRef.current = pastRef.current.slice(0, -1);
    futureRef.current = [...futureRef.current, config];
    syncUndoFlags();
    setConfig(previous);
    await persist(previous);
  }, [config, persist, syncUndoFlags]);

  const redo = useCallback(async () => {
    if (futureRef.current.length === 0) return;
    const next = futureRef.current[futureRef.current.length - 1];
    futureRef.current = futureRef.current.slice(0, -1);
    pastRef.current = [...pastRef.current, config];
    syncUndoFlags();
    setConfig(next);
    await persist(next);
  }, [config, persist, syncUndoFlags]);

  return { config, updateConfig, replaceConfig, resetConfig, undo, redo, canUndo, canRedo, loading, error };
}
