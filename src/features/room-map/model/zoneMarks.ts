import type { RoomMapConfig } from "@/shared/contracts/roomMap";

import { findBoundZone } from "./hueChannelPosition";
import { parseObjectId } from "./objectId";

/** Which Hue zones the 3D room outlines while it is edited: one drawn and named, the others faint. */
export interface ZoneMarks {
  active: string | null;
  others: readonly string[];
}

/** The zone being edited, or else the one the selected light is bound to; the area's other zones
 *  with the plan's zones toggle, as the plan draws them. */
export function zoneMarks(
  config: RoomMapConfig,
  areaZoneIds: readonly string[],
  activeZoneId: string | null,
  selectedId: string | null,
  showAll: boolean,
): ZoneMarks {
  const ref = selectedId ? parseObjectId(selectedId) : null;
  const channel = ref?.kind === "hue" ? config.hueChannels.find((c) => c.channelIndex === ref.channelIndex) : undefined;
  const active = activeZoneId ?? (channel ? (findBoundZone(channel, config.zones)?.id ?? null) : null);
  return { active, others: showAll ? areaZoneIds.filter((id) => id !== active) : [] };
}
