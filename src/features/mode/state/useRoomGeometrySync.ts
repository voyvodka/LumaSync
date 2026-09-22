import { useEffect, useRef } from "react";

import { toRoomGeometry } from "@/features/room-map/model/roomGeometry";
import { loadShellState, onShellStateSaved } from "@/features/shell/windowLifecycle";
import type { RoomGeometry } from "@/shared/contracts/roomMap";

import type { ModeCommandResult } from "../modeApi";
import { SET_LIGHTING_MODE_MIN_INTERVAL_MS } from "./useLightingModeDispatch";

/** A drag commits a save per move; one reload per settled edit is enough. */
export const ROOM_GEOMETRY_RELOAD_DEBOUNCE_MS = 500;

/** `null` is the dispatcher's "deduped or cooled down"; `undefined` means nothing
 *  was asked — no Ambilight running, or the invoke failed and was logged. */
export type RoomGeometryChangeHandler = (
  geometry: RoomGeometry | undefined,
) => Promise<ModeCommandResult | null | undefined>;

/**
 * Re-projects the room geometry whenever this window saves `roomMap` or
 * `lastHueAreaId` — those have many writers, and none of them knows about the
 * running worker. The handler is read through a ref so the retry below sees the
 * mode as of when it fires, not as of the save.
 */
export function useRoomGeometrySync(onRoomGeometryChange: RoomGeometryChangeHandler): void {
  const handlerRef = useRef(onRoomGeometryChange);
  handlerRef.current = onRoomGeometryChange;

  useEffect(() => {
    let debounceTimer: number | null = null;
    let retryTimer: number | null = null;
    let generation = 0;

    const clearRetry = () => {
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
        retryTimer = null;
      }
    };

    const reload = async () => {
      const own = ++generation;
      clearRetry();
      let geometry: RoomGeometry | undefined;
      try {
        geometry = toRoomGeometry(await loadShellState());
      } catch (error) {
        console.error("[LumaSync] room geometry reload failed:", error);
        return;
      }
      if (own !== generation) return;
      const result = await handlerRef.current(geometry);
      if (result !== null || own !== generation) return;
      // The dispatcher answers `null` for both a dedup and its 20 ms cooldown, and
      // the cooldown drops rather than queues. One retry past the window is
      // enough: if anything else dispatched in between, it was hydrated from the
      // geometry already written above, and this retry dedups against it.
      retryTimer = window.setTimeout(() => {
        retryTimer = null;
        if (own !== generation) return;
        void handlerRef.current(geometry);
      }, SET_LIGHTING_MODE_MIN_INTERVAL_MS + 1);
    };

    const unsubscribe = onShellStateSaved((saved) => {
      if (!("roomMap" in saved) && !("lastHueAreaId" in saved)) return;
      if (debounceTimer !== null) window.clearTimeout(debounceTimer);
      debounceTimer = window.setTimeout(() => {
        debounceTimer = null;
        void reload();
      }, ROOM_GEOMETRY_RELOAD_DEBOUNCE_MS);
    });

    return () => {
      unsubscribe();
      generation++;
      if (debounceTimer !== null) window.clearTimeout(debounceTimer);
      clearRetry();
    };
  }, []);
}
