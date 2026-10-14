import { useMemo } from "react";

import type { HueChannelPlacement, RoomMapConfig } from "@/shared/contracts/roomMap";

import { scopeHueChannels } from "../model/hueChannelScope";
import { type RoomMapHueArea, useRoomMapHueArea } from "./useRoomMapHueArea";
import { type UseRoomMapHueChannelsReturn, useRoomMapHueChannels } from "./useRoomMapHueChannels";
import { type UseRoomMapStateReturn, useRoomMapState } from "./useRoomMapState";

/** The room map both faces read: one config, history, selection and save queue, and the Hue area
 *  it is bound to. The surface owns it, so moving between the plan and the 3D room keeps undo,
 *  the selection and a gesture still waiting to save, and the bridge's channels are seeded
 *  whichever face is open. */
export interface RoomMapDocument extends UseRoomMapStateReturn, RoomMapHueArea {
  hue: UseRoomMapHueChannelsReturn;
  /** The bound area's channels: the ones the faces draw and select. */
  visibleHueChannels: HueChannelPlacement[];
  /** `config` with only those channels — what the dock, the property bar and the viewer read. */
  scopedConfig: RoomMapConfig;
}

export function useRoomMapDocument(): RoomMapDocument {
  const state = useRoomMapState();
  const area = useRoomMapHueArea();
  const hue = useRoomMapHueChannels({
    config: state.config,
    adopt: state.adopt,
    hueAreaId: area.hueAreaId,
    hueBridgeConfigured: area.hueBridgeConfigured,
    ready: !state.loading,
  });

  // The editor's object ids carry an index and no area, so it shows one area at
  // a time; placing several independently is P3 work and needs a wider id.
  const visibleHueChannels = useMemo(
    () => scopeHueChannels(state.config.hueChannels, area.hueAreaId),
    [state.config.hueChannels, area.hueAreaId],
  );
  // What the dock and the property bar read: the same one area the canvas
  // draws, or an object list and inspector keyed on `hue-<index>` would show,
  // and select, another area's same-numbered channel.
  const scopedConfig = useMemo<RoomMapConfig>(
    () =>
      visibleHueChannels === state.config.hueChannels
        ? state.config
        : { ...state.config, hueChannels: visibleHueChannels },
    [state.config, visibleHueChannels],
  );

  return { ...state, ...area, hue, visibleHueChannels, scopedConfig };
}
