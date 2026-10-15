import { useCallback } from "react";

import { landCarried } from "../model/carryLanding";
import type { RoomMapDocument } from "./useRoomMapDocument";

/**
 * Where a piece carried across the 3D room is put down on the plan, inside the walls: the scene's
 * origin is the room's middle, the plan's its top-left corner. One landing for both 3D stages, the
 * View face and the editor's. False when it is not put down, so the view puts it back.
 */
export function useLandCarried(doc: Pick<RoomMapDocument, "apply" | "config" | "hueAreaId" | "scopedConfig">) {
  const { apply, config, hueAreaId, scopedConfig } = doc;
  const { widthMeters, depthMeters } = scopedConfig.dimensions;
  return useCallback(
    (objectId: string, sceneX: number, sceneZ: number, turnDeg: number) => {
      const cx = sceneX + widthMeters / 2;
      const cy = sceneZ + depthMeters / 2;
      if (!landCarried(config, objectId, cx, cy, turnDeg, { hueAreaId })) return false;
      apply((cfg) => landCarried(cfg, objectId, cx, cy, turnDeg, { hueAreaId }) ?? {});
      return true;
    },
    [apply, config, hueAreaId, widthMeters, depthMeters],
  );
}
