import { useCallback } from "react";

import { landCarriedWith, type Raised } from "../model/carryLanding";
import type { RoomMapDocument } from "./useRoomMapDocument";

/**
 * Where a piece carried across the 3D room is put down on the plan, inside the walls: the scene's
 * origin is the room's middle, the plan's its top-left corner. False when it is not put down, so
 * the view puts it back.
 */
export function useLandCarried(doc: Pick<RoomMapDocument, "apply" | "config" | "hueAreaId" | "scopedConfig">) {
  const { apply, config, hueAreaId, scopedConfig } = doc;
  const { widthMeters, depthMeters } = scopedConfig.dimensions;
  return useCallback(
    (objectId: string, sceneX: number, sceneZ: number, turnDeg: number, riders: readonly string[] = [], raised?: Raised) => {
      const cx = sceneX + widthMeters / 2;
      const cy = sceneZ + depthMeters / 2;
      if (!landCarriedWith(config, objectId, cx, cy, turnDeg, riders, { hueAreaId }, raised)) return false;
      apply((cfg) => landCarriedWith(cfg, objectId, cx, cy, turnDeg, riders, { hueAreaId }, raised) ?? {});
      return true;
    },
    [apply, config, hueAreaId, widthMeters, depthMeters],
  );
}
