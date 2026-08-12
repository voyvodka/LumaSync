import { HUE_READINESS_REASON } from "@/shared/contracts/hue";
import type { HueEntertainmentAreaSummary } from "../hueOnboardingApi";
import type { HueAreaGroup, HueAreaReadiness, HueAreaRow } from "./onboardingTypes";

export const ACTIVE_STREAMER_REASON = HUE_READINESS_REASON.ACTIVE_STREAMER;

export function normalizeAreas(
  areas: HueEntertainmentAreaSummary[],
  readinessById: Map<string, HueAreaReadiness>,
): HueAreaGroup[] {
  const rows: HueAreaRow[] = areas.map((area) => {
    const room = area.roomName?.trim();
    return {
      ...area,
      roomLabel: room && room.length > 0 ? room : "Other rooms",
      sortRoomKey: (room ?? "other rooms").toLocaleLowerCase(),
      sortNameKey: area.name.toLocaleLowerCase(),
      readiness: readinessById.get(area.id) ?? null,
    };
  });

  rows.sort((left, right) => {
    const roomOrder = left.sortRoomKey.localeCompare(right.sortRoomKey);
    if (roomOrder !== 0) {
      return roomOrder;
    }

    return left.sortNameKey.localeCompare(right.sortNameKey);
  });

  const groups = new Map<string, HueAreaGroup>();
  for (const row of rows) {
    const existing = groups.get(row.roomLabel);
    if (existing) {
      existing.areas.push(row);
      continue;
    }

    groups.set(row.roomLabel, {
      roomName: row.roomLabel,
      areas: [row],
    });
  }

  return Array.from(groups.values());
}

export function flattenAreaGroups(areaGroups: HueAreaGroup[]): HueAreaRow[] {
  return areaGroups.flatMap((group) => group.areas);
}

export function applyAreaReadinessSnapshot(
  areaGroups: HueAreaGroup[],
  areaId: string,
  readiness: HueAreaReadiness,
): HueAreaGroup[] {
  // The bridge readiness probe re-fetches the entertainment area on every
  // call, so `reasons` is the freshest signal we have for whether a
  // foreign streamer is still attached. Mirror that into the area row
  // so the active-streamer banner (which reads `area.activeStreamer`)
  // clears as soon as the foreign session disconnects, without the user
  // having to manually click revalidate (A3.1).
  const activeStreamer = readiness.reasons.includes(ACTIVE_STREAMER_REASON);
  return areaGroups.map((group) => ({
    ...group,
    areas: group.areas.map((area) =>
      area.id === areaId
        ? {
            ...area,
            readiness,
            activeStreamer,
          }
        : area,
    ),
  }));
}
