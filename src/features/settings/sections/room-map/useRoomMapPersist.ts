import { useState, useEffect, useCallback, useRef } from "react";
import { shellStore } from "../../../persistence/shellStore";
import type { RoomMapConfig } from "../../../../shared/contracts/roomMap";
import { DEFAULT_ROOM_MAP } from "../../../../shared/contracts/roomMap";

export interface UseRoomMapPersistReturn {
  config: RoomMapConfig;
  updateConfig: (partial: Partial<RoomMapConfig>) => Promise<void>;
  replaceConfig: (full: RoomMapConfig) => Promise<void>;
  resetConfig: () => Promise<void>;
  loading: boolean;
  error: string | null;
}

export function useRoomMapPersist(): UseRoomMapPersistReturn {
  const [config, setConfig] = useState<RoomMapConfig>(DEFAULT_ROOM_MAP);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const versionRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    shellStore
      .load()
      .then((state) => {
        if (cancelled) return;
        if (state.roomMap) {
          setConfig(state.roomMap);
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

  const updateConfig = useCallback(
    async (partial: Partial<RoomMapConfig>) => {
      const next = { ...config, ...partial };
      setConfig(next);
      await persist(next);
    },
    [config, persist],
  );

  const replaceConfig = useCallback(
    async (full: RoomMapConfig) => {
      setConfig(full);
      await persist(full);
    },
    [persist],
  );

  const resetConfig = useCallback(async () => {
    setConfig(DEFAULT_ROOM_MAP);
    await persist(DEFAULT_ROOM_MAP);
  }, [persist]);

  return { config, updateConfig, replaceConfig, resetConfig, loading, error };
}
