import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { shellStore } from "@/features/persistence/shellStore";
import type { RoomMapConfig } from "@/shared/contracts/roomMap";
import { DEFAULT_ROOM_MAP } from "@/shared/contracts/roomMap";
import { parseCommandError } from "@/shared/contracts/status";
import {
  GESTURE_COALESCE_MS,
  initialRoomMapState,
  roomMapReducer,
  type RoomMapPatch,
} from "./roomMapReducer";

export interface ApplyOptions {
  /** Consecutive applies under one key inside the coalescing window are one
   *  undo step and one save — a held arrow key, a slider being dragged. */
  gesture?: string;
  /** The key auto-repeated, so it belongs to the open gesture regardless of time. */
  continued?: boolean;
}

export interface UseRoomMapStateReturn {
  config: RoomMapConfig;
  selectedId: string | null;
  activeHueZoneId: string | null;
  /** A user edit: one undo entry (or joins the open gesture) and one save. */
  apply: (patch: RoomMapPatch, options?: ApplyOptions) => void;
  /** Like `apply` but outside undo history — for writes the user did not make. */
  adopt: (patch: RoomMapPatch) => void;
  replace: (full: RoomMapConfig) => void;
  reset: () => void;
  undo: () => void;
  redo: () => void;
  select: (objectId: string | null) => void;
  selectHueZone: (hueZoneId: string | null) => void;
  canUndo: boolean;
  canRedo: boolean;
  loading: boolean;
  error: string | null;
}

/** Config, undo history and selection for the room-map editor, in one reducer.
 *  Every change that must reach disk bumps `saveSeq`; a change inside an open
 *  gesture defers its save until the gesture goes quiet, and unmount flushes. */
export function useRoomMapState(): UseRoomMapStateReturn {
  const [state, dispatch] = useReducer(roomMapReducer, undefined, initialRoomMapState);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const versionRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    shellStore
      .load()
      .then((stored) => {
        if (cancelled) return;
        if (stored.roomMap) {
          const loaded = { ...stored.roomMap };
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
          dispatch({ type: "hydrate", config: loaded });
          versionRef.current = stored.roomMapVersion ?? 0;
        }
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        const reason = parseCommandError(err).message;
        console.error(`[LumaSync] Room map load failed: ${reason}`);
        setError(reason);
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
      const reason = parseCommandError(err).message;
      console.error(`[LumaSync] Room map save failed: ${reason}`);
      setError(reason);
    }
  }, []);

  const pendingRef = useRef<RoomMapConfig | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handledSeqRef = useRef(0);

  const flush = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const pending = pendingRef.current;
    if (pending === null) return;
    pendingRef.current = null;
    void persist(pending);
  }, [persist]);

  useEffect(() => {
    if (state.saveSeq === handledSeqRef.current) return;
    handledSeqRef.current = state.saveSeq;
    pendingRef.current = state.config;
    if (!state.saveDeferred) {
      flush();
      return;
    }
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(flush, GESTURE_COALESCE_MS);
  }, [state.saveSeq, state.saveDeferred, state.config, flush]);

  // Closing the editor mid-gesture must not drop the last nudge.
  useEffect(() => flush, [flush]);

  const apply = useCallback((patch: RoomMapPatch, options?: ApplyOptions) => {
    dispatch({
      type: "apply",
      patch,
      gesture: options?.gesture
        ? { key: options.gesture, at: Date.now(), continued: options.continued }
        : undefined,
    });
  }, []);

  const adopt = useCallback((patch: RoomMapPatch) => dispatch({ type: "adopt", patch }), []);
  const replace = useCallback(
    (full: RoomMapConfig) => dispatch({ type: "apply", patch: full, replace: true }),
    [],
  );
  const reset = useCallback(
    () => dispatch({ type: "apply", patch: DEFAULT_ROOM_MAP, replace: true }),
    [],
  );
  const undo = useCallback(() => dispatch({ type: "undo" }), []);
  const redo = useCallback(() => dispatch({ type: "redo" }), []);
  const select = useCallback(
    (objectId: string | null) => dispatch({ type: "select", objectId }),
    [],
  );
  const selectHueZone = useCallback(
    (hueZoneId: string | null) => dispatch({ type: "selectHueZone", hueZoneId }),
    [],
  );

  return {
    config: state.config,
    selectedId: state.selection.objectId,
    activeHueZoneId: state.selection.hueZoneId,
    apply,
    adopt,
    replace,
    reset,
    undo,
    redo,
    select,
    selectHueZone,
    canUndo: state.past.length > 0,
    canRedo: state.future.length > 0,
    loading,
    error,
  };
}
