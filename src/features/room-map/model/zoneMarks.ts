import type { RoomMapConfig } from "@/shared/contracts/roomMap";

import { findBoundZone } from "./hueChannelPosition";
import { parseObjectId } from "./objectId";

/** Which Hue zones the 3D room outlines while it is edited: one drawn and named, the others faint. */
export interface ZoneMarks {
  active: string | null;
  /** The zone that is itself the selection, so it can be carried and resized; not one only shown for a selected light. */
  held: string | null;
  others: readonly string[];
}

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
  return { active, held: selectedId === null ? activeZoneId : null, others: showAll ? areaZoneIds.filter((id) => id !== active) : [] };
}
