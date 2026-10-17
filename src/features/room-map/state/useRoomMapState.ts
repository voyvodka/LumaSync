import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { shellStore } from "@/features/persistence/shellStore";
import type { RoomMapConfig } from "@/shared/contracts/roomMap";
import { DEFAULT_ROOM_MAP } from "@/shared/contracts/roomMap";
import { parseCommandError } from "@/shared/contracts/status";
import { mergeEditorSave } from "../model/roomMapMerge";
import { cubeZones } from "../model/zoneCube";
import { applyRoomTemplate } from "../model/roomTemplate";
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
  /** Neither an object nor a zone: back to the palette. */
  clearSelection: () => void;
  canUndo: boolean;
  canRedo: boolean;
  loading: boolean;
  error: string | null;
  /** The stored map could not be read: nothing may be written over it until a reload reads it. */
  loadFailed: boolean;
  reload: () => void;
  /** Writes the map as it is now again, after a save failed. */
  retrySave: () => void;
}

/** Config, undo history and selection for the room-map editor, in one reducer.
 *  Every change that must reach disk bumps `saveSeq`; a change inside an open
 *  gesture defers its save until the gesture goes quiet, and unmount flushes. */
export function useRoomMapState(): UseRoomMapStateReturn {
  const [state, dispatch] = useReducer(roomMapReducer, undefined, initialRoomMapState);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadTry, setLoadTry] = useState(0);
  // The map as the editor last loaded or wrote it: a save writes only what changed since, so a
  // strip, LED count or channel another writer stored meanwhile survives (`mergeEditorSave`).
  // Read when a save runs, not when it is asked for: a save queued behind one that fails must
  // write whole, or the failed one's edit never reaches the file.
  const writtenRef = useRef<RoomMapConfig | null>(DEFAULT_ROOM_MAP);
  const savingRef = useRef<Promise<void> | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a reload is the trigger.
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
          // A file an older build wrote after the 11 → 12 step can hold zones that are not cubes.
          dispatch({ type: "hydrate", config: cubeZones(loaded) });
          // The stored map as it is, not the converted copy, so the conversion reaches the file.
          writtenRef.current = stored.roomMap;
        }
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        const reason = parseCommandError(err).message;
        console.error(`[LumaSync] Room map load failed: ${reason}`);
        setLoadFailed(true);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [loadTry]);

  const reload = useCallback(() => {
    setLoadFailed(false);
    setLoading(true);
    setLoadTry((n) => n + 1);
  }, []);

  const persist = useCallback((next: RoomMapConfig) => {
    const run = async () => {
      const base = writtenRef.current;
      try {
        await shellStore.update((current) => ({
          roomMap: mergeEditorSave(current.roomMap ?? DEFAULT_ROOM_MAP, base, next),
        }));
        writtenRef.current = next;
        setError(null);
      } catch (err) {
        writtenRef.current = null;
        const reason = parseCommandError(err).message;
        console.error(`[LumaSync] Room map save failed: ${reason}`);
        setError(reason);
      }
    };
    // One after another, so a later save never lands before an earlier one; the first starts at
    // once, so the unmount flush is under way before the editor is gone.
    const queued = savingRef.current;
    const saving = queued === null ? run() : queued.then(run);
    savingRef.current = saving;
    void saving.finally(() => {
      if (savingRef.current === saving) savingRef.current = null;
    });
    return saving;
  }, []);

  const configRef = useRef(state.config);
  configRef.current = state.config;
  const retrySave = useCallback(() => {
    void persist(configRef.current);
  }, [persist]);

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
  // An empty template, not the empty map: the Hue channels and zones belong to
  // the bridge sync and the port-linked strips to Devices, and a reset that
  // wiped them left the map disagreeing with both.
  const reset = useCallback(
    () =>
      dispatch({
        type: "apply",
        patch: (config) => applyRoomTemplate(config, DEFAULT_ROOM_MAP),
        replace: true,
      }),
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
  const clearSelection = useCallback(() => dispatch({ type: "clearSelection" }), []);

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
    clearSelection,
    canUndo: state.past.length > 0,
    canRedo: state.future.length > 0,
    loading,
    error,
    loadFailed,
    reload,
    retrySave,
  };
}
