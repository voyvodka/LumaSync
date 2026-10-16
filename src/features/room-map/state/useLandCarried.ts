import { useCallback } from "react";

import type { HueChannelPlacement } from "@/shared/contracts/roomMap";

import { landCarriedWith, type Raised } from "../model/carryLanding";
import { findScopedHueChannel } from "../model/hueChannelScope";
import { parseObjectId } from "../model/objectId";
import type { RoomMapDocument } from "./useRoomMapDocument";

/**
 * Where a piece carried across the 3D room is put down on the plan, inside the walls: the scene's
 * origin is the room's middle, the plan's its top-left corner. False when it is not put down, so
 * the view puts it back. `dropInto` takes over a landing Hue light by returning true.
 */
export function useLandCarried(
  doc: Pick<RoomMapDocument, "apply" | "config" | "hueAreaId" | "scopedConfig">,
  dropInto?: (channel: HueChannelPlacement) => boolean,
) {
  const { apply, config, hueAreaId, scopedConfig } = doc;
  const { widthMeters, depthMeters } = scopedConfig.dimensions;
  return useCallback(
    (objectId: string, sceneX: number, sceneZ: number, turnDeg: number, riders: readonly string[] = [], raised?: Raised) => {
      const cx = sceneX + widthMeters / 2;
      const cy = sceneZ + depthMeters / 2;
      const landed = landCarriedWith(config, objectId, cx, cy, turnDeg, riders, { hueAreaId }, raised);
      if (!landed) return false;
      const ref = parseObjectId(objectId);
      const light = ref?.kind === "hue" && landed.hueChannels ? findScopedHueChannel(landed.hueChannels, hueAreaId, ref.channelIndex) : undefined;
      if (light && dropInto?.(light)) return true;
      apply((cfg) => landCarriedWith(cfg, objectId, cx, cy, turnDeg, riders, { hueAreaId }, raised) ?? {});
      return true;
    },
    [apply, config, hueAreaId, widthMeters, depthMeters, dropInto],
  );
}
